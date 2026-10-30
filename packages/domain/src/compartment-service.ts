import { randomUUID } from 'node:crypto';
import {
  compartmentAccessRequestSchema,
  CoreError,
  createCompartmentSchema,
  narrowAccessSchema,
  type ActorContext,
} from '@memory/contracts';
import type { Pool, PoolClient } from 'pg';
import { withAuthorizedActor } from './authorized-transaction.js';
import {
  allowanceIds,
  canonicalLabel,
  compartmentNotAvailable,
  normalizeCompartmentName,
  resolveCompartments,
  resolveWriteLabel,
} from './compartments.js';

/** The Gate connection whose allowance an operation reads or changes. */
export interface ConnectionRef {
  readonly issuer: string;
  readonly subject: string;
  readonly connectionId: string;
  readonly clientId: string;
}

/** How a widening was approved: by the binding's policy or by the person at Gate. */
export interface AllowanceApproval {
  readonly by: 'policy' | 'person';
  readonly confirmationId: string;
}

type AllowanceChange = 'create_compartment' | 'narrow' | 'widen';

/**
 * Compartments and per-connection allowances. A connection may create a compartment and narrow
 * its own allowance at once; widening is a protected change that the caller applies only after
 * the binding's approval policy approved it.
 */
export class CompartmentService {
  constructor(private readonly pool: Pool) {}

  /** What this connection can use, by name and ID, and how its writes are labeled. */
  async getAccess(actor: ActorContext): Promise<Record<string, unknown>> {
    return withAuthorizedActor(
      this.pool,
      actor,
      authorizedScopes(actor),
      'read',
      async (client) => {
        const scopes = await client.query<{ id: string; name: string }>(
          'SELECT id::text AS id, name FROM scopes WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY name, id',
          [actor.userId, authorizedScopes(actor)],
        );
        const allowance = allowanceIds(actor);
        const compartments = await client.query<{ id: string; name: string }>(
          `SELECT id::text AS id, name FROM compartments
         WHERE user_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
         ORDER BY normalized_name`,
          [actor.userId, allowance],
        );
        const names = new Map(compartments.rows.map((row) => [row.id, row.name]));
        const writeDefault = resolveWriteLabel(actor, undefined).ids;
        return {
          scopes: scopes.rows,
          capabilities: actor.capabilities,
          compartments: compartments.rows,
          general_visible: true,
          write_default: writeDefault.map((id) => ({ id, name: names.get(id) ?? id })),
          general_write_held: allowance !== null && allowance.length > 0,
          allowance_epoch:
            actor.compartments.kind === 'allowance' ? actor.compartments.epoch : null,
        };
      },
    );
  }

  /** Creates a compartment and adds it to the calling connection's allowance. */
  async createCompartment(
    actor: ActorContext,
    connection: ConnectionRef,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parse(createCompartmentSchema, raw, 'Compartment request is invalid');
    const normalized = normalizeCompartmentName(request.name);
    if (normalized.length === 0) throw new CoreError(400, 'invalid_request', 'Name is empty');
    return withAuthorizedActor(
      this.pool,
      actor,
      authorizedScopes(actor),
      'write',
      async (client) => {
        const id = randomUUID();
        try {
          await client.query('SAVEPOINT create_compartment');
          await client.query(
            `INSERT INTO compartments (user_id, id, name, normalized_name, created_by,
             created_by_client_id, created_by_connection_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              actor.userId,
              id,
              request.name.trim(),
              normalized,
              actor.principalId,
              connection.clientId,
              connection.connectionId,
            ],
          );
          await client.query('RELEASE SAVEPOINT create_compartment');
        } catch (error) {
          if ((error as { code?: string }).code !== '23505') throw error;
          await client.query('ROLLBACK TO SAVEPOINT create_compartment');
          throw new CoreError(409, 'compartment_exists', 'A compartment with this name exists');
        }
        const allowance = await changeAllowance(
          client,
          actor,
          connection,
          'create_compartment',
          (current) => [...current, id],
          undefined,
        );
        return { compartment: { id, name: request.name.trim() }, allowance };
      },
    );
  }

  /** Removes compartments from the calling connection's own allowance at once. */
  async narrowAccess(
    actor: ActorContext,
    connection: ConnectionRef,
    raw: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parse(narrowAccessSchema, raw, 'Narrowing request is invalid');
    return withAuthorizedActor(
      this.pool,
      actor,
      authorizedScopes(actor),
      'write',
      async (client) => {
        const remove = await resolveCompartments(client, actor, request.compartments);
        return {
          allowance: await changeAllowance(
            client,
            actor,
            connection,
            'narrow',
            (current) => current.filter((id) => !remove.includes(id)),
            undefined,
          ),
        };
      },
    );
  }

  /**
   * The compartments a widening request names, resolved even when outside the allowance; the
   * caller named them, so this reveals only whether they exist.
   */
  async resolveRequestedCompartments(
    actor: ActorContext,
    raw: unknown,
  ): Promise<{ readonly id: string; readonly name: string }[]> {
    const request = parse(compartmentAccessRequestSchema, raw, 'Access request is invalid');
    return withAuthorizedActor(
      this.pool,
      actor,
      authorizedScopes(actor),
      'read',
      async (client) => {
        const normalized = request.compartments.map(normalizeCompartmentName);
        const found = await client.query<{ id: string; name: string; normalized_name: string }>(
          `SELECT id::text AS id, name, normalized_name
         FROM app.resolve_compartment_names($1, $2::text[])`,
          [actor.userId, normalized],
        );
        const byName = new Map(found.rows.map((row) => [row.normalized_name, row]));
        return normalized.map((name) => {
          const row = byName.get(name);
          if (row === undefined) throw compartmentNotAvailable();
          return { id: row.id, name: row.name };
        });
      },
    );
  }

  /** Adds approved compartments to a connection's allowance. */
  async widenAccess(
    actor: ActorContext,
    connection: ConnectionRef,
    compartmentIds: readonly string[],
    approval: AllowanceApproval,
  ): Promise<Record<string, unknown>> {
    return withAuthorizedActor(
      this.pool,
      actor,
      authorizedScopes(actor),
      'write',
      async (client) => {
        return {
          allowance: await changeAllowance(
            client,
            actor,
            connection,
            'widen',
            (current) => [...current, ...compartmentIds],
            approval,
          ),
        };
      },
    );
  }
}

function authorizedScopes(actor: ActorContext): string[] {
  const scopes = [...new Set(actor.scopeIds.filter((id) => actor.tokenScopeIds.includes(id)))];
  if (scopes.length === 0) throw new CoreError(403, 'forbidden', 'An authorized scope is required');
  return scopes.sort();
}

/**
 * Changes a connection's allowance from its locked current value and records the change. A
 * connection changing its own allowance must still hold the one it authenticated with; an
 * approved widening applies to the requesting connection whatever it holds now. The transaction
 * marks the row so its own commit revalidation accepts the new epoch.
 */
async function changeAllowance(
  client: PoolClient,
  actor: ActorContext,
  connection: ConnectionRef,
  change: AllowanceChange,
  mutate: (current: readonly string[]) => readonly string[],
  approval: AllowanceApproval | undefined,
): Promise<Record<string, unknown>> {
  if (actor.compartments.kind !== 'allowance') {
    throw new CoreError(400, 'connection_required', 'Only an AI connection has an allowance');
  }
  const locked = await client.query<{ compartment_ids: string[]; epoch: string }>(
    `SELECT compartment_ids::text[] AS compartment_ids, epoch::text AS epoch
     FROM connection_allowances
     WHERE user_id = $1 AND external_issuer = $2 AND external_subject = $3 AND connection_id = $4
     FOR UPDATE`,
    [actor.userId, connection.issuer, connection.subject, connection.connectionId],
  );
  const previous = locked.rows[0];
  const previousEpoch = Number(previous?.epoch ?? 0);
  if (change !== 'widen' && previousEpoch !== actor.compartments.epoch) {
    throw new CoreError(
      403,
      'stale_authorization',
      "The connection's compartment allowance changed; retry with a newly verified credential",
      true,
    );
  }
  const label = canonicalLabel(mutate(previous?.compartment_ids ?? []));
  const epoch = previousEpoch + 1;
  await client.query(
    `INSERT INTO connection_allowances (user_id, external_issuer, external_subject, connection_id,
       compartment_ids, epoch, changed_by_transaction)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, pg_current_xact_id())
     ON CONFLICT (user_id, external_issuer, external_subject, connection_id) DO UPDATE
       SET compartment_ids = EXCLUDED.compartment_ids, epoch = EXCLUDED.epoch,
           changed_by_transaction = EXCLUDED.changed_by_transaction, updated_at = clock_timestamp()`,
    [actor.userId, connection.issuer, connection.subject, connection.connectionId, label, epoch],
  );
  await client.query(
    `INSERT INTO connection_allowance_events (user_id, external_issuer, external_subject,
       connection_id, change, previous_compartment_ids, compartment_ids, epoch, requested_by,
       client_id, approval, confirmation_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8, $9, $10, $11, $12)`,
    [
      actor.userId,
      connection.issuer,
      connection.subject,
      connection.connectionId,
      change,
      canonicalLabel(previous?.compartment_ids ?? []),
      label,
      epoch,
      actor.principalId,
      connection.clientId,
      approval?.by ?? 'none',
      approval?.confirmationId ?? null,
    ],
  );
  return { compartment_ids: label, epoch };
}

function parse<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  raw: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new CoreError(400, 'invalid_request', message, false, parsed.error.issues);
  return parsed.data;
}
