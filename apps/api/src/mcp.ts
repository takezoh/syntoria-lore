import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { CoreError, memoryInputSchema, type ActorContext } from '@memory/contracts';
import type { Authenticator } from '@memory/auth';
import type { CompartmentService, CoreService } from '@memory/domain';
import type { ConnectorService } from '@memory/connectors';
import type { CurationReviewService } from '@memory/jobs';
import type { ForgetService, PortabilityService } from '@memory/governance';
import type { RecallService } from '@memory/recall';
import { reviewDecisionSchema } from '@memory/contracts';
import { z } from 'zod';
import type { ChangeConfirmationService, ProtectedChange } from './confirmations.js';
import { connectionOf } from './connection.js';

export interface McpEndpointOptions {
  readonly productDisplayName: string;
  readonly auth: Authenticator;
  readonly core: CoreService;
  readonly recall?: RecallService;
  readonly connectors?: ConnectorService;
  readonly reviews?: CurationReviewService;
  readonly governance?: ForgetService;
  readonly portability?: PortabilityService;
  readonly confirmations?: ChangeConfirmationService;
  readonly compartments?: CompartmentService;
  readonly maxBodyBytes: number;
}

const compartmentRefs = z.array(z.string().trim().min(1).max(100)).max(32);

const CONFIRMATION_NOTE =
  ' Your connection acts for the User, so the person’s approval policy decides: either the change is applied at once and the result carries approval.by "policy", or this returns confirmation_required with a Gate URL; then show the URL to the person and call complete_confirmation after they approve.';

export async function handleMcpRequest(
  options: McpEndpointOptions,
  incoming: Request,
  /** The caller, already authenticated for the single MCP resource audience. */
  actor: ActorContext,
): Promise<Response> {
  if (incoming.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }

  // A protected change runs directly for the User and becomes a Gate confirmation otherwise.
  const protectedChange = async (
    change: ProtectedChange,
    idempotencyKey: string | undefined,
    direct: () => Promise<unknown>,
  ): Promise<unknown> =>
    options.confirmations === undefined
      ? direct()
      : (await options.confirmations.run(options.auth, actor, change, idempotencyKey, randomUUID()))
          .result;

  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: `${options.productDisplayName} MCP`, version: '0.1.0' },
        {
          instructions:
            'Call get_access first: it lists the scopes and compartments this connection can use, by name. A compartment is a confidentiality boundary such as an employer or a private matter; you receive only General memories and those in your compartments, and what you save is labeled with your compartments unless you name others. The tools available to this authenticated actor reflect its current read and write capabilities. Every operation still checks the requested scope and current grants. Results are subject to current source rights and Forget suppressions. Your connection acts for the person, never as them, so everything you save is an AI proposal. To record the person’s own decision or preference, propose the changeset and call request_user_decision. Protected changes use the person’s approval policy: they apply at once with approval.by "policy", or return confirmation_required with a Gate URL to show the person, then call complete_confirmation after approval. Ask before requesting a change the person did not ask for.',
        },
      );
      if (actor.capabilities.includes('read')) {
        if (options.recall !== undefined) {
          server.registerTool(
            'recall_memories',
            {
              description:
                'Retrieve memories using current rights and deletion filters, from every authorized scope unless scope_id names one. Name compartments to narrow the search to them and General.',
              inputSchema: {
                query: z.string().trim().min(1).max(2000),
                scope_id: z.uuid().optional(),
                compartments: compartmentRefs.optional(),
                mode: z
                  .enum(['precise', 'contextual', 'historical', 'exploratory', 'changes'])
                  .optional(),
                limit: z.number().int().min(1).max(100).optional(),
              },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ query, scope_id, compartments, mode, limit }) =>
              toolResult(
                await options.recall!.recall(actor, {
                  query,
                  scope_ids: scope_id === undefined ? [] : [scope_id],
                  ...(compartments === undefined ? {} : { compartments }),
                  ...(mode === undefined ? {} : { mode }),
                  ...(limit === undefined ? {} : { limit }),
                }),
              ),
          );
        }
        if (options.compartments !== undefined) {
          server.registerTool(
            'get_access',
            {
              description:
                'List the scopes and compartments this connection can use, by name and ID, how its writes are labeled by default, and the approval policy for protected changes. Call this before other tools.',
              inputSchema: {},
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async () =>
              toolResult({
                ...(await options.compartments!.getAccess(actor)),
                approval_policy: options.auth.gateIdentity(actor)?.approvalPolicy ?? null,
              }),
          );
        }
        server.registerTool(
          'get_memory',
          {
            description:
              'Read a memory and its authorized provenance. scope_id may be omitted to search every authorized scope.',
            inputSchema: {
              scope_id: z.uuid().optional(),
              memory_id: z.uuid(),
              valid_at: z.iso.datetime({ offset: true }).optional(),
              known_at: z.iso.datetime({ offset: true }).optional(),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          async ({ scope_id, memory_id, valid_at, known_at }) => {
            const query = {
              ...(valid_at === undefined ? {} : { valid_at }),
              ...(known_at === undefined ? {} : { known_at }),
            };
            if (scope_id !== undefined)
              return toolResult(await options.core.getMemory(actor, scope_id, memory_id, query));
            for (const scope of authorizedScopes(actor)) {
              try {
                return toolResult(await options.core.getMemory(actor, scope, memory_id, query));
              } catch (error) {
                if (!(error instanceof CoreError) || error.status !== 404) throw error;
              }
            }
            throw new CoreError(404, 'not_found', 'Memory not found');
          },
        );
        server.registerTool(
          'get_changes',
          {
            description:
              'Read the authorized changes feed, for every authorized scope unless scope_id names one.',
            inputSchema: {
              scope_id: z.uuid().optional(),
              limit: z.number().int().min(1).max(200).optional(),
              cursor: z.string().max(4096).optional(),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
          async ({ scope_id, limit, cursor }) =>
            toolResult(
              await options.core.getChanges(
                actor,
                {
                  scope_ids: scope_id === undefined ? [] : [scope_id],
                  ...(limit === undefined ? {} : { limit }),
                  ...(cursor === undefined ? {} : { cursor }),
                },
                randomUUID(),
              ),
            ),
        );
        if (options.confirmations !== undefined) {
          server.registerTool(
            'get_confirmation',
            {
              description:
                'Read the status of a change waiting for the User’s approval at Gate, including its Gate URL while it is pending.',
              inputSchema: { confirmation_id: z.uuid() },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ confirmation_id }) =>
              toolResult(await options.confirmations!.get(actor, confirmation_id)),
          );
        }
        if (options.governance !== undefined) {
          server.registerTool(
            'forget_status',
            {
              description: 'Read the status of a durable Forget request.',
              inputSchema: { scope_id: z.uuid(), request_id: z.uuid() },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ scope_id, request_id }) =>
              toolResult(await options.governance!.status(actor, scope_id, request_id)),
          );
        }
        if (options.reviews !== undefined) {
          server.registerTool(
            'capture_status',
            {
              description: 'Read a capture job status in an authorized scope.',
              inputSchema: { job_id: z.uuid() },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ job_id }) => toolResult(await options.reviews!.jobStatus(actor, job_id)),
          );
          server.registerTool(
            'list_reviews',
            {
              description: 'List curation review items visible to the caller.',
              inputSchema: {
                scope_id: z.uuid(),
                status: z.enum(['held', 'approved', 'rejected', 'stale']).optional(),
                limit: z.number().int().min(1).max(100).optional(),
              },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ scope_id, status, limit }) =>
              toolResult(
                await options.reviews!.list(actor, {
                  scope_id,
                  ...(status === undefined ? {} : { status }),
                  ...(limit === undefined ? {} : { limit }),
                }),
              ),
          );
          server.registerTool(
            'get_review',
            {
              description: 'Read a curation review item visible to the caller.',
              inputSchema: { review_id: z.uuid() },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ review_id }) => toolResult(await options.reviews!.get(actor, review_id)),
          );
        }
        if (options.portability !== undefined) {
          server.registerTool(
            'export_status',
            {
              description: 'Read an async encrypted export job status.',
              inputSchema: { scope_id: z.uuid(), export_id: z.uuid() },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
            },
            async ({ scope_id, export_id }) =>
              toolResult(await options.portability!.exportStatus(actor, scope_id, export_id)),
          );
        }
      }
      if (actor.capabilities.includes('write')) {
        server.registerTool(
          'remember_memory',
          {
            description:
              'Write a memory with explicit evidence. scope_id may be omitted when this connection can write one scope. Without memory.compartments the memory is labeled with your compartments; an empty list asks for General, which is held in your compartments until a relaxation is approved when you hold any. Your connection acts for the person, so the memory is saved as an AI proposal; use propose_changeset and request_user_decision to record what the person decided with their authority.',
            inputSchema: {
              scope_id: z.uuid().optional(),
              memory: memoryInputSchema,
              idempotency_key: z.string().min(1).max(256),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
          },
          async ({ scope_id, memory, idempotency_key }) => {
            const result = await options.core.remember(
              actor,
              { ...(scope_id === undefined ? {} : { scope_id }), memory },
              randomUUID(),
              idempotency_key,
            );
            return toolResult(result);
          },
        );
        if (options.compartments !== undefined) {
          server.registerTool(
            'create_compartment',
            {
              description:
                'Create a compartment, a confidentiality boundary such as an employer, client or private matter, and add it to this connection. Only connections that hold it receive memories labeled with it. Prefer neutral names: a name that already exists cannot be created again.',
              inputSchema: { name: z.string().trim().min(1).max(100) },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
            },
            async ({ name }) =>
              toolResult(
                await options.compartments!.createCompartment(
                  actor,
                  connectionOf(options.auth, actor),
                  { name },
                ),
              ),
          );
          server.registerTool(
            'narrow_access',
            {
              description:
                'Stop this connection from receiving memories in the named compartments. Takes effect at once; getting them back needs request_compartment_access.',
              inputSchema: { compartments: compartmentRefs.min(1) },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ compartments }) =>
              toolResult(
                await options.compartments!.narrowAccess(actor, connectionOf(options.auth, actor), {
                  compartments,
                }),
              ),
          );
          server.registerTool(
            'request_compartment_access',
            {
              description:
                'Ask for this connection to receive memories in more compartments, named as the person named them. Only request what the person asked for.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                compartments: compartmentRefs.min(1),
                idempotency_key: z.string().min(1).max(256).optional(),
              },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ compartments, idempotency_key }) =>
              toolResult(
                await protectedChange(
                  { operation: 'change_connection_allowance', request: { compartments } },
                  idempotency_key,
                  () => {
                    throw new CoreError(
                      400,
                      'connection_required',
                      'Only an AI connection has an allowance',
                    );
                  },
                ),
              ),
          );
        }
        if (options.governance !== undefined) {
          server.registerTool(
            'forget_memory',
            {
              description:
                'Immediately suppress a memory and queue independently durable physical deletion.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                scope_id: z.uuid(),
                memory_id: z.uuid(),
                idempotency_key: z.string().min(1).max(256),
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ scope_id, memory_id, idempotency_key }) => {
              const request = {
                scope_id,
                selector: { memory_ids: [memory_id] },
                reason_code: 'user_requested',
              };
              const result = await protectedChange(
                { operation: 'forget', request },
                idempotency_key,
                () => options.governance!.forget(actor, request, idempotency_key),
              );
              return toolResult(result);
            },
          );
        }
        if (options.connectors !== undefined) {
          server.registerTool(
            'configure_source',
            {
              description:
                'Enable or disable capture from one source in an authorized scope. Enabling records the person’s consent for Lore to accept and curate that source.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                scope_id: z.uuid(),
                source_kind: z.enum(['chat', 'document', 'tool_result', 'episode']),
                external_id: z.string().min(1).max(512),
                enabled: z.boolean(),
                consent: z.boolean(),
                metadata: z.record(z.string(), z.unknown()).optional(),
                compartments: compartmentRefs.optional(),
              },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async (source) =>
              toolResult(
                await protectedChange(
                  { operation: 'configure_source', request: source },
                  undefined,
                  () => options.connectors!.configure(actor, source),
                ),
              ),
          );
          server.registerTool(
            'capture',
            {
              description:
                'Queue consented source observations for curation in one authorized scope.',
              inputSchema: {
                scope_id: z.uuid(),
                operation_id: z.string().min(1).max(256),
                source: z.strictObject({
                  kind: z.enum(['chat', 'document', 'tool_result', 'episode']),
                  external_id: z.string().min(1).max(512),
                  revision: z.string().min(1).max(128).optional(),
                }),
                observations: z
                  .array(
                    z.strictObject({
                      locator: z.string().min(1).max(2048),
                      content: z.string().min(1).max(32768),
                      speaker: z.string().max(256).optional(),
                      event_time: z.iso.datetime({ offset: true }).optional(),
                      lineage_root: z.uuid().optional(),
                    }),
                  )
                  .min(1)
                  .max(256),
                idempotency_key: z.string().min(1).max(256),
              },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ idempotency_key, ...capture }) =>
              toolResult(
                await options.connectors!.capture(actor, capture, idempotency_key, randomUUID()),
              ),
          );
        }
        server.registerTool(
          'propose_changeset',
          {
            description:
              'Propose an authorized changeset for explicit review/commit. Your connection acts for the person, so commit records it as an AI proposal and request_user_decision records it with their authority under their approval policy.',
            inputSchema: {
              scope_id: z.uuid(),
              operations: z.array(z.unknown()).min(1).max(64),
              idempotency_key: z.string().min(1).max(256),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
          },
          async ({ idempotency_key, ...changeSet }) =>
            toolResult(
              await options.core.proposeChangeSet(actor, changeSet, randomUUID(), idempotency_key),
            ),
        );
        server.registerTool(
          'commit_changeset',
          {
            description:
              'Commit a previously proposed changeset under current authorization and revisions.',
            inputSchema: { changeset_id: z.uuid(), idempotency_key: z.string().min(1).max(256) },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
          },
          async ({ changeset_id, idempotency_key }) =>
            toolResult(
              await options.core.commitProposedChangeSet(
                actor,
                changeset_id,
                randomUUID(),
                idempotency_key,
              ),
            ),
        );
        if (options.confirmations !== undefined) {
          server.registerTool(
            'request_user_decision',
            {
              description:
                'Ask the User to commit a proposed changeset with their own authority, for decisions, preferences and corrections they stated. Show every change in the proposal to the person first.' +
                CONFIRMATION_NOTE,
              inputSchema: { changeset_id: z.uuid(), idempotency_key: z.string().min(1).max(256) },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ changeset_id, idempotency_key }) =>
              toolResult(
                await protectedChange(
                  { operation: 'commit_changeset', changesetId: changeset_id },
                  idempotency_key,
                  () =>
                    options.core.commitProposedChangeSet(
                      actor,
                      changeset_id,
                      randomUUID(),
                      idempotency_key,
                    ),
                ),
              ),
          );
          server.registerTool(
            'complete_confirmation',
            {
              description:
                'Apply a change after the person approved it at Gate. Returns pending, denied or expired without changing anything otherwise. A change the approval policy already applied is returned as committed.',
              inputSchema: { confirmation_id: z.uuid() },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ confirmation_id }) =>
              toolResult(
                await options.confirmations!.complete(
                  options.auth,
                  actor,
                  confirmation_id,
                  randomUUID(),
                ),
              ),
          );
        }
        if (options.reviews !== undefined) {
          server.registerTool(
            'decide_review',
            {
              description:
                'Approve or reject a visible curation review under current revisions and User confirmation rules.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                review_id: z.uuid(),
                idempotency_key: z.string().min(1).max(256),
                decision: reviewDecisionSchema,
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ review_id, idempotency_key, decision }) =>
              toolResult(
                await protectedChange(
                  { operation: 'decide_review', reviewId: review_id, decision },
                  idempotency_key,
                  () =>
                    options.reviews!.decide(
                      actor,
                      review_id,
                      decision,
                      randomUUID(),
                      idempotency_key,
                    ),
                ),
              ),
          );
        }
        if (options.governance !== undefined) {
          server.registerTool(
            'change_source_rights',
            {
              description:
                'Change User-granted source rights and invalidate dependent memory visibility.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                source_id: z.uuid(),
                scope_id: z.uuid(),
                rights_status: z.enum(['granted', 'revoked']),
                consent: z.boolean(),
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ source_id, scope_id, rights_status, consent }) => {
              const request = { scope_id, rights_status, consent };
              return toolResult(
                await protectedChange(
                  { operation: 'change_source_rights', sourceId: source_id, request },
                  undefined,
                  () => options.governance!.updateSourceRights(actor, source_id, request),
                ),
              );
            },
          );
          server.registerTool(
            'change_scope_grant',
            {
              description:
                'Create, update, or revoke one principal grant under current User administration.' +
                CONFIRMATION_NOTE,
              inputSchema: {
                scope_id: z.uuid(),
                principal_id: z.uuid(),
                capabilities: z
                  .array(z.enum(['read', 'write', 'admin']))
                  .min(1)
                  .max(3)
                  .optional(),
                expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
                revoke: z.boolean().optional(),
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ scope_id, ...grant }) =>
              toolResult(
                await protectedChange(
                  { operation: 'change_scope_grant', scopeId: scope_id, request: grant },
                  undefined,
                  () => options.governance!.mutateGrant(actor, scope_id, grant),
                ),
              ),
          );
          server.registerTool(
            'set_retention_policy',
            {
              description:
                'Set bounded retention ages for an authorized scope.' + CONFIRMATION_NOTE,
              inputSchema: {
                scope_id: z.uuid(),
                observation_days: z.number().int().min(1).max(36500),
                memory_days: z.number().int().min(1).max(36500).nullable().optional(),
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ scope_id, ...policy }) =>
              toolResult(
                await protectedChange(
                  { operation: 'set_retention_policy', scopeId: scope_id, request: policy },
                  undefined,
                  () => options.governance!.updateRetention(actor, scope_id, policy),
                ),
              ),
          );
          server.registerTool(
            'submit_feedback',
            {
              description:
                'Record feedback and queue reassessment without promoting consensus to truth.',
              inputSchema: {
                scope_id: z.uuid(),
                memory_id: z.uuid(),
                feedback_type: z.enum(['useful', 'incorrect', 'stale', 'not_relevant']),
                metadata: z.record(z.string(), z.unknown()).optional(),
              },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ scope_id, memory_id, feedback_type, metadata }) =>
              toolResult(
                await options.governance!.submitFeedback(actor, {
                  scope_id,
                  memory_id,
                  feedback_type,
                  ...(metadata === undefined ? {} : { metadata }),
                }),
              ),
          );
        }
        if (options.portability !== undefined) {
          server.registerTool(
            'request_export',
            {
              description: 'Request an asynchronous, encrypted, expiring portable export.',
              inputSchema: { scope_id: z.uuid(), idempotency_key: z.string().min(1).max(256) },
              annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ scope_id, idempotency_key }) =>
              toolResult(
                await options.portability!.requestExport(actor, { scope_id }, idempotency_key),
              ),
          );
          server.registerTool(
            'import_bundle',
            {
              description:
                'Import an authenticated encrypted portable bundle with fresh entity IDs and explicit source grant choice.',
              inputSchema: {
                scope_id: z.uuid(),
                encrypted_bundle: z.string().min(1).max(16000000),
                grant_imported_sources: z.boolean().optional(),
                idempotency_key: z.string().min(1).max(256),
              },
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
            },
            async ({ idempotency_key, ...bundle }) =>
              toolResult(await options.portability!.importBundle(actor, bundle, idempotency_key)),
          );
        }
      }
      return server;
    },
    { responseMode: 'json', maxRequestBodySize: options.maxBodyBytes },
  );

  try {
    return await handler.fetch(incoming);
  } finally {
    await handler.close();
  }
}

function toolResult(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    ...(result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { structuredContent: result as Record<string, unknown> }
      : {}),
  };
}

function authorizedScopes(actor: ActorContext): string[] {
  return [...new Set(actor.scopeIds.filter((id) => actor.tokenScopeIds.includes(id)))].sort();
}
