import { randomBytes } from 'node:crypto';
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from '@google-cloud/firestore';
import {
  admissionDocumentId,
  CONNECTION_ID,
  connectionPrincipalIds,
  gateKey,
  isAccessIdentifier,
  MEMORY_ADMISSIONS_COLLECTION,
  WORKER_CONNECTION_ID,
  WORKER_PRINCIPAL_ID,
} from './access.js';
import {
  authorizationDocumentId,
  digest,
  id,
  MEMORY_AUTHORIZATION_COLLECTION,
} from './firestore-repository.js';
import { ALL_WORKSPACES, INBOX, WORKSPACE_ID } from './labels.js';

export { CONNECTION_ID } from './access.js';

/**
 * Workspaces and connections (ADR 0012, docs/design/memory-workspaces.md). A workspace is the
 * enforced boundary, one per company; a connection is an endpoint with a grant of workspaces.
 * Only the operator tool (`scripts/manage-connections.mjs`) calls this registry: a grant decides
 * what a connection may read, so no request or model output reaches it.
 */

/** The connection served at `/mcp`. */
export const DEFAULT_CONNECTION = 'default';

/** The connection ID that Access-mode requests to `/mcp` carry. */
export const SHARED_AI_CONNECTION = 'shared-ai';

const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_NOTE = 500;
const MAX_GRANTED = 100;

export interface AdmissionCoordinates {
  readonly issuer: string;
  readonly subject: string;
}

interface Admission extends AdmissionCoordinates {
  readonly tenantId: string;
  readonly scopeId: string;
}

/** What one connection may read and write. */
export interface ConnectionGrant {
  /** `"all"` grants every workspace, including ones created later. */
  readonly workspaces: 'all' | readonly string[];
  readonly inbox: boolean;
  /** Where a write without a workspace goes; `null` is the Inbox. */
  readonly defaultWorkspace: string | null;
}

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
}

export interface ConnectionView {
  readonly id: string;
  /** The MCP path that serves the connection. */
  readonly path: string;
  readonly grant: ConnectionGrant;
  readonly allowance: readonly string[];
  readonly active: boolean;
  readonly epoch: number;
  readonly updatedAt: string;
}

export type WorkspaceRegistryErrorCode =
  'invalid_input' | 'not_admitted' | 'not_found' | 'conflict';

export class WorkspaceRegistryError extends Error {
  constructor(
    readonly code: WorkspaceRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRegistryError';
  }
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

function text(value: unknown, max: number, field: string, allowEmpty = false): string {
  if (typeof value !== 'string')
    throw new WorkspaceRegistryError('invalid_input', `${field} is required`);
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed === '') || [...trimmed].length > max || hasControlCharacter(trimmed))
    throw new WorkspaceRegistryError(
      'invalid_input',
      `${field} must be ${allowEmpty ? '' : 'non-empty '}printable text of at most ${max} characters`,
    );
  return trimmed;
}

/** Workspace names are compared after NFKC, case folding and whitespace collapsing. */
export function normalizeWorkspaceName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** The allowance a grant gives, as stored in authorization documents. */
export function allowanceForGrant(grant: ConnectionGrant): string[] {
  const workspaces = grant.workspaces === 'all' ? [ALL_WORKSPACES] : grant.workspaces;
  return [...new Set([...(grant.inbox ? [INBOX] : []), ...workspaces])].sort();
}

/** The MCP path of a connection. */
export function connectionPath(connectionId: string): string {
  return connectionId === DEFAULT_CONNECTION ? '/mcp' : `/mcp/c/${connectionId}`;
}

function newId(prefix: 'wsp' | 'con'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

interface AuthorizationTarget {
  readonly principalId: string;
  readonly actorKind: 'connection' | 'person' | 'worker';
  readonly connectionId: string;
  readonly gateClientId: string;
}

function parseGrant(value: unknown): ConnectionGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  const workspaces = data['workspaces'];
  const defaultWorkspace = data['defaultWorkspace'];
  if (
    !(
      workspaces === 'all' ||
      (Array.isArray(workspaces) && workspaces.every((item) => typeof item === 'string'))
    ) ||
    typeof data['inbox'] !== 'boolean' ||
    !(defaultWorkspace === null || typeof defaultWorkspace === 'string')
  )
    return null;
  return {
    workspaces: workspaces === 'all' ? 'all' : [...(workspaces as string[])],
    inbox: data['inbox'],
    defaultWorkspace,
  };
}

export class WorkspaceRegistry {
  constructor(
    private readonly firestore: Firestore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Resolves the active admission of a subject, as `scripts/admit-subject.mjs` wrote it. */
  async admission(coordinates: AdmissionCoordinates): Promise<Admission> {
    const snapshot = await this.firestore
      .collection(MEMORY_ADMISSIONS_COLLECTION)
      .doc(admissionDocumentId(coordinates.issuer, coordinates.subject))
      .get();
    const data = snapshot.data();
    if (
      !data ||
      data['active'] !== true ||
      data['issuer'] !== coordinates.issuer ||
      !isAccessIdentifier(data['tenantId']) ||
      !isAccessIdentifier(data['scopeId'])
    )
      throw new WorkspaceRegistryError('not_admitted', 'No active admission for this subject');
    return { ...coordinates, tenantId: data['tenantId'], scopeId: data['scopeId'] };
  }

  async createWorkspace(
    coordinates: AdmissionCoordinates,
    input: { readonly name: string; readonly description?: string; readonly note?: string },
  ): Promise<WorkspaceView> {
    const admission = await this.admission(coordinates);
    const name = text(input.name, MAX_NAME, 'name');
    const description = text(input.description ?? '', MAX_DESCRIPTION, 'description', true);
    const note = text(input.note ?? '', MAX_NOTE, 'note', true);
    const normalizedName = normalizeWorkspaceName(name);
    const workspaceId = newId('wsp');
    const scope = this.scopeRef(admission);
    const nameRef = scope
      .collection('workspaceNames')
      .doc(digest(['workspace-name', normalizedName]));
    const workspaceRef = scope.collection('workspaces').doc(workspaceId);
    const createdAt = this.now().toISOString();
    const view: WorkspaceView = { id: workspaceId, name, description, createdAt };
    await this.firestore.runTransaction(async (transaction) => {
      if ((await transaction.get(nameRef)).exists)
        throw new WorkspaceRegistryError('conflict', 'A workspace with this name exists');
      transaction.create(workspaceRef, { ...view, normalizedName });
      transaction.create(nameRef, { workspaceId });
      this.history(transaction, admission, 'create-workspace', workspaceId, null, view, note);
    });
    return view;
  }

  async listWorkspaces(coordinates: AdmissionCoordinates): Promise<WorkspaceView[]> {
    const admission = await this.admission(coordinates);
    const snapshot = await this.scopeRef(admission).collection('workspaces').get();
    return snapshot.docs
      .map((document) => ({
        id: String(document.get('id')),
        name: String(document.get('name')),
        description: String(document.get('description') ?? ''),
        createdAt: String(document.get('createdAt')),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Creates or replaces a connection's grant. `"new"` creates a further connection. The
   * connection document and the connection's and person's authorization documents change in one
   * transaction, and their epoch increases, so in-flight actors and cursors become stale.
   */
  async setConnection(
    coordinates: AdmissionCoordinates,
    connection: string,
    grant: ConnectionGrant,
    note = '',
  ): Promise<ConnectionView> {
    const admission = await this.admission(coordinates);
    const checkedNote = text(note, MAX_NOTE, 'note', true);
    const connectionId = connection === 'new' ? newId('con') : connection;
    if (connectionId !== DEFAULT_CONNECTION && !CONNECTION_ID.test(connectionId))
      throw new WorkspaceRegistryError('invalid_input', 'Unknown connection');
    const normalized = this.checkGrant(grant);
    const allowance = allowanceForGrant(normalized);
    const scope = this.scopeRef(admission);
    const connectionRef = scope.collection('connections').doc(connectionId);
    const requestConnectionId =
      connectionId === DEFAULT_CONNECTION ? SHARED_AI_CONNECTION : connectionId;
    const principals = connectionPrincipalIds(
      admission.issuer,
      admission.subject,
      requestConnectionId,
    );
    const targets: AuthorizationTarget[] = [
      {
        principalId: principals.connection,
        actorKind: 'connection',
        connectionId: gateKey(requestConnectionId),
        gateClientId: gateKey(SHARED_AI_CONNECTION),
      },
      {
        principalId: principals.person,
        actorKind: 'person',
        connectionId: gateKey(requestConnectionId),
        gateClientId: gateKey(SHARED_AI_CONNECTION),
      },
    ];
    const updatedAt = this.now().toISOString();
    return this.firestore.runTransaction(async (transaction) => {
      const workspaceIds = normalized.workspaces === 'all' ? [] : [...normalized.workspaces];
      if (normalized.defaultWorkspace !== null) workspaceIds.push(normalized.defaultWorkspace);
      const [current, workspaces, authorizations] = await Promise.all([
        transaction.get(connectionRef),
        Promise.all(
          [...new Set(workspaceIds)].map((workspaceId) =>
            transaction.get(scope.collection('workspaces').doc(workspaceId)),
          ),
        ),
        Promise.all(
          targets.map((target) => transaction.get(this.authorizationRef(admission, target))),
        ),
      ]);
      if (workspaces.some((workspace) => !workspace.exists))
        throw new WorkspaceRegistryError('not_found', 'A granted workspace does not exist');
      if (connection !== 'new' && connectionId !== DEFAULT_CONNECTION && !current.exists)
        throw new WorkspaceRegistryError('not_found', 'Unknown connection');
      const epoch = Number(current.get('epoch') ?? 0) + 1;
      const before = current.exists ? (current.data() ?? null) : null;
      const after = {
        id: connectionId,
        grant: normalized,
        allowance,
        active: true,
        epoch,
        updatedAt,
      };
      transaction.set(connectionRef, after);
      targets.forEach((target, index) =>
        this.writeAuthorization(
          transaction,
          admission,
          target,
          authorizations[index]!,
          allowance,
          true,
          updatedAt,
        ),
      );
      this.history(
        transaction,
        admission,
        'set-connection',
        connectionId,
        before,
        after,
        checkedNote,
      );
      return { ...after, path: connectionPath(connectionId) };
    });
  }

  /** Marks a further connection and its authorization documents inactive. */
  async deactivateConnection(
    coordinates: AdmissionCoordinates,
    connectionId: string,
    note = '',
  ): Promise<ConnectionView> {
    const admission = await this.admission(coordinates);
    const checkedNote = text(note, MAX_NOTE, 'note', true);
    if (!CONNECTION_ID.test(connectionId))
      throw new WorkspaceRegistryError(
        'invalid_input',
        'Only a further connection can be deactivated',
      );
    const scope = this.scopeRef(admission);
    const connectionRef = scope.collection('connections').doc(connectionId);
    const principals = connectionPrincipalIds(admission.issuer, admission.subject, connectionId);
    const targets: AuthorizationTarget[] = (['connection', 'person'] as const).map((actorKind) => ({
      principalId: principals[actorKind],
      actorKind,
      connectionId: gateKey(connectionId),
      gateClientId: gateKey(SHARED_AI_CONNECTION),
    }));
    const updatedAt = this.now().toISOString();
    return this.firestore.runTransaction(async (transaction) => {
      const [current, ...authorizations] = await Promise.all([
        transaction.get(connectionRef),
        ...targets.map((target) => transaction.get(this.authorizationRef(admission, target))),
      ]);
      const grant = parseGrant(current.get('grant'));
      if (!current.exists || grant === null)
        throw new WorkspaceRegistryError('not_found', 'Unknown connection');
      const allowance = allowanceForGrant(grant);
      const after = {
        id: connectionId,
        grant,
        allowance,
        active: false,
        epoch: Number(current.get('epoch') ?? 0) + 1,
        updatedAt,
      };
      transaction.set(connectionRef, after);
      targets.forEach((target, index) =>
        this.writeAuthorization(
          transaction,
          admission,
          target,
          authorizations[index]!,
          allowance,
          false,
          updatedAt,
        ),
      );
      this.history(
        transaction,
        admission,
        'deactivate-connection',
        connectionId,
        current.data() ?? null,
        after,
        checkedNote,
      );
      return { ...after, path: connectionPath(connectionId) };
    });
  }

  async listConnections(coordinates: AdmissionCoordinates): Promise<ConnectionView[]> {
    const admission = await this.admission(coordinates);
    const snapshot = await this.scopeRef(admission).collection('connections').get();
    return snapshot.docs.flatMap((document) => {
      const grant = parseGrant(document.get('grant'));
      if (grant === null) return [];
      return [
        {
          id: document.id,
          path: connectionPath(document.id),
          grant,
          allowance: allowanceForGrant(grant),
          active: document.get('active') === true,
          epoch: Number(document.get('epoch') ?? 0),
          updatedAt: String(document.get('updatedAt')),
        },
      ];
    });
  }

  /**
   * Prepares an existing admission for workspaces: the default connection gets every workspace
   * and the Inbox, and the worker may read every label. Running it again bumps the epochs.
   */
  async initialize(coordinates: AdmissionCoordinates, note = ''): Promise<ConnectionView> {
    const admission = await this.admission(coordinates);
    const checkedNote = text(note, MAX_NOTE, 'note', true);
    const worker: AuthorizationTarget = {
      principalId: WORKER_PRINCIPAL_ID,
      actorKind: 'worker',
      connectionId: WORKER_CONNECTION_ID,
      gateClientId: WORKER_CONNECTION_ID,
    };
    const allowance = allowanceForGrant({ workspaces: 'all', inbox: true, defaultWorkspace: null });
    const updatedAt = this.now().toISOString();
    await this.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(this.authorizationRef(admission, worker));
      this.writeAuthorization(transaction, admission, worker, current, allowance, true, updatedAt);
      this.history(
        transaction,
        admission,
        'set-worker',
        WORKER_PRINCIPAL_ID,
        current.exists
          ? { compartmentAllowance: current.get('compartmentAllowance') ?? null }
          : null,
        { compartmentAllowance: allowance },
        checkedNote,
      );
    });
    return this.setConnection(
      coordinates,
      DEFAULT_CONNECTION,
      { workspaces: 'all', inbox: true, defaultWorkspace: null },
      checkedNote,
    );
  }

  private checkGrant(grant: ConnectionGrant): ConnectionGrant {
    const workspaces = grant.workspaces === 'all' ? 'all' : [...new Set(grant.workspaces)].sort();
    if (
      workspaces !== 'all' &&
      (workspaces.length > MAX_GRANTED || !workspaces.every((item) => WORKSPACE_ID.test(item)))
    )
      throw new WorkspaceRegistryError(
        'invalid_input',
        'Workspaces must be workspace IDs or "all"',
      );
    if (typeof grant.inbox !== 'boolean')
      throw new WorkspaceRegistryError('invalid_input', 'inbox must be true or false');
    const defaultWorkspace = grant.defaultWorkspace;
    if (defaultWorkspace === null) {
      if (!grant.inbox)
        throw new WorkspaceRegistryError(
          'invalid_input',
          'A connection without a default workspace needs the Inbox',
        );
    } else if (
      !WORKSPACE_ID.test(defaultWorkspace) ||
      (workspaces !== 'all' && !workspaces.includes(defaultWorkspace))
    ) {
      throw new WorkspaceRegistryError(
        'invalid_input',
        'The default workspace must be one of the granted workspaces',
      );
    }
    return { workspaces, inbox: grant.inbox, defaultWorkspace };
  }

  private writeAuthorization(
    transaction: Transaction,
    admission: Admission,
    target: AuthorizationTarget,
    current: DocumentSnapshot,
    allowance: readonly string[],
    active: boolean,
    updatedAt: string,
  ): void {
    const ref = this.authorizationRef(admission, target);
    if (current.exists) {
      if (
        current.get('tenantId') !== admission.tenantId ||
        current.get('principalId') !== target.principalId ||
        current.get('actorKind') !== target.actorKind
      )
        throw new WorkspaceRegistryError('conflict', 'An authorization document does not match');
      transaction.update(ref, {
        active,
        compartmentAllowance: [...allowance],
        authorizationEpoch: Number(current.get('authorizationEpoch') ?? 0) + 1,
        updatedAt,
      });
      return;
    }
    transaction.create(ref, {
      active,
      tenantId: admission.tenantId,
      principalId: target.principalId,
      actorKind: target.actorKind,
      connectionId: target.connectionId,
      gateClientId: target.gateClientId,
      authorizationEpoch: 1,
      compartmentAllowance: [...allowance],
      revokedSourceReferences: [],
      createdAt: updatedAt,
    });
  }

  private history(
    transaction: Transaction,
    admission: Admission,
    operation: string,
    target: string,
    before: unknown,
    after: unknown,
    note: string,
  ): void {
    transaction.create(this.scopeRef(admission).collection('accessHistory').doc(), {
      operation,
      target,
      before: before ?? null,
      after: after ?? null,
      writer: 'operator',
      note,
      at: this.now().toISOString(),
    });
  }

  private authorizationRef(admission: Admission, target: AuthorizationTarget): DocumentReference {
    return this.firestore
      .collection(MEMORY_AUTHORIZATION_COLLECTION)
      .doc(authorizationDocumentId(admission.tenantId, target.principalId, admission.scopeId));
  }

  private scopeRef(admission: Admission): DocumentReference {
    return this.firestore
      .collection('memoryTenants')
      .doc(id(admission.tenantId))
      .collection('scopes')
      .doc(id(admission.scopeId));
  }
}
