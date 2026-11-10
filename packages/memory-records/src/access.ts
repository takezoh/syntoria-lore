import { createHash } from 'node:crypto';
import type { DocumentData, Firestore } from '@google-cloud/firestore';
import {
  authorizationDocumentId,
  MEMORY_AUTHORIZATION_COLLECTION,
  type FirestoreMemoryRecordRepository,
  type VerifiedActorCapability,
} from './firestore-repository.js';

/** Admissions, one per Gate subject, keyed by {@link admissionDocumentId}. */
export const MEMORY_ADMISSIONS_COLLECTION = 'memoryAdmissions';

/** The approval policy that lets a protected change apply at once with `policy` provenance. */
export const AUTOMATIC_APPROVAL_POLICY = 'automatic';

const WORKER_PRINCIPAL_ID = 'worker:lore-api';
const WORKER_CONNECTION_ID = 'lore-api';

/** A principal whose Gate token was introspected for this resource. */
export interface GatePrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
}

/**
 * What an admitted Gate connection may do. Issued only by {@link MemoryAccess.resolve}; the other
 * access methods refuse an object they did not issue.
 */
export interface ConnectionAccess {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly approvalPolicy: string;
  /** The connection's own actor: it writes AI proposals and reads within its allowance. */
  readonly actor: VerifiedActorCapability;
  /** The stable pseudonymous key of the admitted Gate subject. */
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

/** The admission document ID for one Gate subject. */
export function admissionDocumentId(issuer: string, subject: string): string {
  return sha256('lore-admission-v1', issuer, subject);
}

/** Gate identifiers are opaque; any value that is not a short plain token is stored as a digest. */
function gateKey(value: string): string {
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
  /** The allowance a new document starts with; an existing document is never changed here. */
  readonly initialAllowance: readonly string[];
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
 * pass only Gate-verified principals; every field of the capability comes from that principal
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
 * Admission and authorization for Gate connections. Admissions are created only by the operator
 * tool (`scripts/admit-subject.mjs`); this class reads them and never writes them. It creates a
 * missing authorization document with an empty allowance (General only) and never widens an
 * existing one.
 */
export class MemoryAccess {
  private readonly issued = new WeakSet<ConnectionAccess>();

  constructor(
    private readonly firestore: Firestore,
    private readonly repository: FirestoreMemoryRecordRepository,
  ) {}

  /** Resolves a verified Gate principal to its admission and its connection actor. */
  async resolve(principal: GatePrincipal): Promise<ConnectionAccess> {
    if (
      !textValue(principal.issuer) ||
      !textValue(principal.subject) ||
      !textValue(principal.connectionId) ||
      !textValue(principal.clientId)
    ) {
      throw new AccessDeniedError('not_admitted', 'The Gate principal is incomplete');
    }
    const subjectKey = admissionDocumentId(principal.issuer, principal.subject);
    const admissionSnapshot = await this.firestore
      .collection(MEMORY_ADMISSIONS_COLLECTION)
      .doc(subjectKey)
      .get();
    const admission = parseAdmission(admissionSnapshot.data(), principal.issuer);
    if (!admission) {
      throw new AccessDeniedError('not_admitted', 'This Gate subject is not admitted to Lore');
    }
    const connectionKey = sha256(
      'lore-connection-v1',
      principal.issuer,
      principal.subject,
      principal.connectionId,
    );
    const template: AuthorizationTemplate = {
      tenantId: admission.tenantId,
      scopeId: admission.scopeId,
      principalId: `connection:${connectionKey}`,
      actorKind: 'connection',
      connectionId: gateKey(principal.connectionId),
      gateClientId: gateKey(principal.clientId),
      initialAllowance: [],
    };
    const stored = await this.ensureAuthorization(template);
    const access: ConnectionAccess = Object.freeze({
      tenantId: admission.tenantId,
      scopeId: admission.scopeId,
      approvalPolicy: admission.approvalPolicy,
      actor: mintActor({ ...template, stored }),
      subjectKey,
      personPrincipalId: `person:${connectionKey}`,
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
      initialAllowance: access.actor.compartmentAllowance,
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
      initialAllowance: [],
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
          compartmentAllowance: [...template.initialAllowance],
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
