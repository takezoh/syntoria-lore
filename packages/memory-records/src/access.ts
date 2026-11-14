import { createHash } from 'node:crypto';
import type { DocumentData, Firestore } from '@google-cloud/firestore';
import {
  authorizationDocumentId,
  MEMORY_AUTHORIZATION_COLLECTION,
  type FirestoreMemoryRecordRepository,
  type VerifiedActorCapability,
} from './firestore-repository.js';
import { ALL_WORKSPACES, INBOX } from './labels.js';

/** Admissions, one per admitted subject, keyed by {@link admissionDocumentId}. */
export const MEMORY_ADMISSIONS_COLLECTION = 'memoryAdmissions';

/** The approval policy that lets a protected change apply at once with `policy` provenance. */
export const AUTOMATIC_APPROVAL_POLICY = 'automatic';

export const WORKER_PRINCIPAL_ID = 'worker:lore-api';

/**
 * The allowance of the default connection and the worker (ADR 0012): every workspace, including
 * ones created later, and the Inbox. Shared observations need no grant.
 */
export const FULL_ALLOWANCE: readonly string[] = Object.freeze([INBOX, ALL_WORKSPACES].sort());

/**
 * Further connections are opaque: `con_` and 32 lower-case hexadecimal digits. Their
 * authorization documents are written only by the operator tool; a request for one that was
 * never provisioned is denied, never created.
 */
export const CONNECTION_ID = /^con_[a-f0-9]{32}$/u;
export const WORKER_CONNECTION_ID = 'lore-api';

/**
 * A verified principal: the existing admission's issuer and subject, which the service maps an
 * authenticated Access assertion to, and the connection the request uses.
 */
export interface AuthenticatedPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
}

/**
 * What an admitted connection may do. Issued only by {@link MemoryAccess.resolve}; the other
 * access methods refuse an object they did not issue.
 */
export interface ConnectionAccess {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly approvalPolicy: string;
  /** The connection's own actor: it writes AI proposals and reads within its allowance. */
  readonly actor: VerifiedActorCapability;
  /** The stable pseudonymous key of the admitted subject. */
  readonly subjectKey: string;
  /** The principal that holds the person's authority when it acts through this connection. */
  readonly personPrincipalId: string;
}

export type AccessDeniedCode = 'not_admitted' | 'authorization_unavailable' | 'user_required';

export class AccessDeniedError extends Error {
  constructor(
    readonly code: AccessDeniedCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

function sha256(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

const textValue = (value: unknown, maxBytes = 1024): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= maxBytes &&
  !hasControlCharacter(value);

/** Tenant, scope and compartment identifiers: short, printable and free of path separators. */
export function isAccessIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

/** IDs that this package derives for approvals and requests. */
function isDerivedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]+_[a-f0-9]{16,64}$/u.test(value);
}

/** The admission document ID for one admitted subject. */
export function admissionDocumentId(issuer: string, subject: string): string {
  return sha256('lore-admission-v1', issuer, subject);
}

/**
 * The principal IDs of one connection of an admitted subject. The default connection uses the
 * connection ID the authenticated request carries (`shared-ai` in Access mode); a further
 * connection uses its own `con_…` ID.
 */
export function connectionPrincipalIds(
  issuer: string,
  subject: string,
  connectionId: string,
): { readonly connection: string; readonly person: string } {
  const key = sha256('lore-connection-v1', issuer, subject, connectionId);
  return { connection: `connection:${key}`, person: `person:${key}` };
}

/**
 * Connection and client identifiers are stored as given when they are short plain tokens, and as
 * a digest otherwise. The stored fields keep their earlier names, `connectionId` and
 * `gateClientId`.
 */
export function gateKey(value: string): string {
  return /^[A-Za-z0-9._:@-]{1,128}$/u.test(value)
    ? value
    : `sha256:${sha256('lore-gate-id-v1', value)}`;
}

interface Admission {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly approvalPolicy: string;
}

function parseAdmission(value: DocumentData | undefined, issuer: string): Admission | null {
  if (
    !value ||
    value['active'] !== true ||
    value['issuer'] !== issuer ||
    !isAccessIdentifier(value['tenantId']) ||
    !isAccessIdentifier(value['scopeId']) ||
    !textValue(value['approvalPolicy'], 64)
  ) {
    return null;
  }
  return {
    tenantId: value['tenantId'],
    scopeId: value['scopeId'],
    approvalPolicy: value['approvalPolicy'],
  };
}

interface AuthorizationTemplate {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly principalId: string;
  readonly actorKind: VerifiedActorCapability['actorKind'];
  readonly connectionId: string;
  readonly gateClientId: string;
  /**
   * The allowance a missing document is created with, or `null` when a missing document denies
   * access. An existing document is never changed here.
   */
  readonly initialAllowance: readonly string[] | null;
}

interface StoredAuthorization {
  readonly authorizationEpoch: number;
  readonly compartmentAllowance: readonly string[];
}

function parseAuthorization(
  value: DocumentData | undefined,
  expected: AuthorizationTemplate,
): StoredAuthorization | null {
  if (
    !value ||
    value['active'] !== true ||
    value['tenantId'] !== expected.tenantId ||
    value['principalId'] !== expected.principalId ||
    value['actorKind'] !== expected.actorKind ||
    value['connectionId'] !== expected.connectionId ||
    value['gateClientId'] !== expected.gateClientId ||
    !Number.isSafeInteger(value['authorizationEpoch']) ||
    Number(value['authorizationEpoch']) < 0 ||
    !Array.isArray(value['compartmentAllowance']) ||
    !value['compartmentAllowance'].every(isAccessIdentifier) ||
    !Array.isArray(value['revokedSourceReferences'])
  ) {
    return null;
  }
  return {
    authorizationEpoch: Number(value['authorizationEpoch']),
    compartmentAllowance: [...(value['compartmentAllowance'] as string[])],
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The one place that turns verified identity into a {@link VerifiedActorCapability}. Callers
 * pass only verified principals; every field of the capability comes from that principal
 * and the stored admission and authorization documents, never from request data.
 */
function mintActor(fields: {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly principalId: string;
  readonly actorKind: VerifiedActorCapability['actorKind'];
  readonly connectionId: string;
  readonly gateClientId: string;
  readonly stored: StoredAuthorization;
  readonly protectedChangeApproval?: VerifiedActorCapability['protectedChangeApproval'];
}): VerifiedActorCapability {
  return Object.freeze({
    tenantId: fields.tenantId,
    principalId: fields.principalId,
    actorKind: fields.actorKind,
    connectionId: fields.connectionId,
    gateClientId: fields.gateClientId,
    scopeIds: Object.freeze([fields.scopeId]),
    compartmentAllowance: Object.freeze([...fields.stored.compartmentAllowance]),
    authorizationEpoch: fields.stored.authorizationEpoch,
    ...(fields.protectedChangeApproval === undefined
      ? {}
      : { protectedChangeApproval: Object.freeze({ ...fields.protectedChangeApproval }) }),
  }) as unknown as VerifiedActorCapability;
}

/**
 * Admission and authorization for connections. Admissions are created only by the operator tool
 * (`scripts/admit-subject.mjs`); this class reads them and never writes them. It creates a
 * missing authorization document of the default connection or the worker with
 * {@link FULL_ALLOWANCE} and never changes an existing one; only the operator tool
 * (`scripts/manage-connections.mjs`) changes an allowance.
 */
export class MemoryAccess {
  private readonly issued = new WeakSet<ConnectionAccess>();

  constructor(
    private readonly firestore: Firestore,
    private readonly repository: FirestoreMemoryRecordRepository,
  ) {}

  /** Resolves a verified principal to its admission and its connection actor. */
  async resolve(principal: AuthenticatedPrincipal): Promise<ConnectionAccess> {
    if (
      !textValue(principal.issuer) ||
      !textValue(principal.subject) ||
      !textValue(principal.connectionId) ||
      !textValue(principal.clientId)
    ) {
      throw new AccessDeniedError('not_admitted', 'The principal is incomplete');
    }
    const subjectKey = admissionDocumentId(principal.issuer, principal.subject);
    const admissionSnapshot = await this.firestore
      .collection(MEMORY_ADMISSIONS_COLLECTION)
      .doc(subjectKey)
      .get();
    const admission = parseAdmission(admissionSnapshot.data(), principal.issuer);
    if (!admission) {
      throw new AccessDeniedError('not_admitted', 'This subject is not admitted to Lore');
    }
    const principals = connectionPrincipalIds(
      principal.issuer,
      principal.subject,
      principal.connectionId,
    );
    const template: AuthorizationTemplate = {
      tenantId: admission.tenantId,
      scopeId: admission.scopeId,
      principalId: principals.connection,
      actorKind: 'connection',
      connectionId: gateKey(principal.connectionId),
      gateClientId: gateKey(principal.clientId),
      // Only the default connection is provisioned on first use; a further connection must have
      // been created by the operator tool, so an unknown one fails closed.
      initialAllowance: CONNECTION_ID.test(principal.connectionId) ? null : FULL_ALLOWANCE,
    };
    const stored = await this.ensureAuthorization(template);
    const access: ConnectionAccess = Object.freeze({
      tenantId: admission.tenantId,
      scopeId: admission.scopeId,
      approvalPolicy: admission.approvalPolicy,
      actor: mintActor({ ...template, stored }),
      subjectKey,
      personPrincipalId: principals.person,
    });
    this.issued.add(access);
    return access;
  }

  /**
   * Grants the person's authority for one protected change under the admission's approval
   * policy. With the `automatic` policy it records the controlled approval for the exact
   * request digest and returns a person actor bound to it; any other policy needs the person's
   * own confirmation, which this release does not offer.
   */
  async approveByPolicy(
    access: ConnectionAccess,
    request: { readonly protectedChangeId: string; readonly requestDigest: string },
  ): Promise<VerifiedActorCapability> {
    this.assertIssued(access);
    if (access.approvalPolicy !== AUTOMATIC_APPROVAL_POLICY) {
      throw new AccessDeniedError(
        'user_required',
        "This change needs the person's own confirmation, which this release does not support",
      );
    }
    if (
      !isDerivedIdentifier(request.protectedChangeId) ||
      !/^[a-f0-9]{64}$/u.test(request.requestDigest)
    ) {
      throw new TypeError('Invalid protected change request');
    }
    const template: AuthorizationTemplate = {
      tenantId: access.tenantId,
      scopeId: access.scopeId,
      principalId: access.personPrincipalId,
      actorKind: 'person',
      connectionId: access.actor.connectionId,
      gateClientId: access.actor.gateClientId,
      initialAllowance: CONNECTION_ID.test(access.actor.connectionId)
        ? null
        : access.actor.compartmentAllowance,
    };
    const stored = await this.ensureAuthorization(template);
    if (!sameSet(stored.compartmentAllowance, access.actor.compartmentAllowance)) {
      throw new AccessDeniedError(
        'authorization_unavailable',
        "The person's authorization for this connection does not match the connection's allowance",
      );
    }
    const actor = mintActor({
      ...template,
      stored,
      protectedChangeApproval: {
        provenance: 'policy',
        protectedChangeId: request.protectedChangeId,
        requestDigest: request.requestDigest,
      },
    });
    await this.repository.recordPolicyApproval(actor, access.scopeId);
    return actor;
  }

  /** The in-process worker for the scope: indexing, purge and restore reconciliation. */
  async worker(access: ConnectionAccess): Promise<VerifiedActorCapability> {
    this.assertIssued(access);
    const template: AuthorizationTemplate = {
      tenantId: access.tenantId,
      scopeId: access.scopeId,
      principalId: WORKER_PRINCIPAL_ID,
      actorKind: 'worker',
      connectionId: WORKER_CONNECTION_ID,
      gateClientId: WORKER_CONNECTION_ID,
      initialAllowance: FULL_ALLOWANCE,
    };
    return mintActor({ ...template, stored: await this.ensureAuthorization(template) });
  }

  private assertIssued(access: ConnectionAccess): void {
    if (!this.issued.has(access)) throw new TypeError('Connection access was not issued here');
  }

  private async ensureAuthorization(template: AuthorizationTemplate): Promise<StoredAuthorization> {
    const ref = this.firestore
      .collection(MEMORY_AUTHORIZATION_COLLECTION)
      .doc(authorizationDocumentId(template.tenantId, template.principalId, template.scopeId));
    let data = (await ref.get()).data();
    if (data === undefined && template.initialAllowance === null) {
      throw new AccessDeniedError('not_admitted', 'This connection is not provisioned');
    }
    if (data === undefined) {
      data = await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) return snapshot.data();
        const created = {
          active: true,
          tenantId: template.tenantId,
          principalId: template.principalId,
          actorKind: template.actorKind,
          connectionId: template.connectionId,
          gateClientId: template.gateClientId,
          authorizationEpoch: 1,
          compartmentAllowance: [...(template.initialAllowance ?? [])],
          revokedSourceReferences: [],
          createdAt: new Date().toISOString(),
        };
        transaction.create(ref, created);
        return created;
      });
    }
    const stored = parseAuthorization(data, template);
    if (!stored) {
      throw new AccessDeniedError(
        'authorization_unavailable',
        'The authorization for this connection is inactive or invalid',
      );
    }
    return stored;
  }
}
