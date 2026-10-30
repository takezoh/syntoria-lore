import { z } from 'zod';

export * from './legacy-storage-contract.js';
export { bindActorAuthorizationGuard, getActorAuthorizationGuard } from './actor-authorization.js';
export type { ActorAuthorizationGuard } from './actor-authorization.js';

export const uuidSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
export const memoryKindSchema = z.enum([
  'fact',
  'decision',
  'preference',
  'hypothesis',
  'experience',
  'procedure',
]);
export const actorKindSchema = z.enum(['user', 'client', 'connector', 'curator']);
export const capabilitySchema = z.enum(['read', 'write', 'admin']);
export const lifecycleSchema = z.enum([
  'candidate',
  'active',
  'superseded',
  'retracted',
  'forgotten',
]);
export const epistemicStatusSchema = z.enum(['asserted', 'observed', 'inferred', 'proposed']);
export const authoritySchema = z.enum([
  'user_decision',
  'user_preference',
  'user_assertion',
  'third_party_claim',
  'observed_state',
  'ai_proposal',
]);

const nonBlank = (max: number) => z.string().trim().min(1).max(max);

export const subjectAliasInputSchema = z.strictObject({
  name: nonBlank(256),
  valid_from: timestampSchema.nullable().default(null),
  valid_to: timestampSchema.nullable().default(null),
});

export const subjectInputSchema = z.strictObject({
  name: nonBlank(256),
  aliases: z.array(subjectAliasInputSchema).max(32).default([]),
});

export const evidenceInputSchema = z.strictObject({
  source: z.strictObject({
    kind: z.enum(['chat', 'document', 'tool_result', 'episode', 'explicit_remember']),
    external_id: nonBlank(512),
    revision: nonBlank(128).default('1'),
    locator: nonBlank(2048),
  }),
  span: z.string().max(8192).optional(),
  speaker: z.string().max(256).optional(),
  event_time: timestampSchema.optional(),
  captured_at: timestampSchema.optional(),
  snippet: z.string().max(8192).optional(),
  snippet_allowed: z.boolean().default(false),
});

/** A compartment named by its ID or by its name. */
export const compartmentRefSchema = nonBlank(100);
const compartmentRefs = z.array(compartmentRefSchema).max(32);

export const memoryInputSchema = z.strictObject({
  kind: memoryKindSchema,
  statement: nonBlank(10000),
  context: z.record(z.string(), z.unknown()).default({}),
  subjects: z.array(subjectInputSchema).max(32).default([]),
  valid_from: timestampSchema.nullable().default(null),
  valid_to: timestampSchema.nullable().default(null),
  epistemic_status: epistemicStatusSchema.default('asserted'),
  contested: z.boolean().default(false),
  evidence: z.array(evidenceInputSchema).min(1).max(64),
  /** The label to apply; omitted means the connection's default. An empty list means General. */
  compartments: compartmentRefs.optional(),
});

const memoryTarget = z.strictObject({
  memory_id: uuidSchema,
  expected_revision: z.number().int().positive(),
});
const evidenceSet = z.strictObject({ evidence: z.array(evidenceInputSchema).min(1).max(64) });

export const changeOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('CREATE'), memory: memoryInputSchema }),
  z.strictObject({ op: z.literal('CORROBORATE'), ...memoryTarget.shape, ...evidenceSet.shape }),
  z.strictObject({
    op: z.literal('REFINE'),
    ...memoryTarget.shape,
    statement: nonBlank(10000).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    valid_from: timestampSchema.nullable().optional(),
    valid_to: timestampSchema.nullable().optional(),
    epistemic_status: epistemicStatusSchema.optional(),
    ...evidenceSet.shape,
  }),
  z.strictObject({
    op: z.literal('SUPERSEDE'),
    ...memoryTarget.shape,
    replacement: memoryInputSchema,
  }),
  z.strictObject({
    op: z.literal('CONTEST'),
    ...memoryTarget.shape,
    reason: nonBlank(4000),
    ...evidenceSet.shape,
  }),
  z.strictObject({
    op: z.literal('RELATE'),
    from_memory_id: uuidSchema,
    from_expected_revision: z.number().int().positive(),
    to_memory_id: uuidSchema,
    to_expected_revision: z.number().int().positive(),
    relation: z.enum([
      'supersedes',
      'supports',
      'contradicts',
      'related_to',
      'same_subject',
      'depends_on_context',
    ]),
    context: z.record(z.string(), z.unknown()).default({}),
  }),
  z.strictObject({
    op: z.literal('RETRACT'),
    ...memoryTarget.shape,
    reason: nonBlank(4000),
  }),
  z.strictObject({ op: z.literal('NO_OP'), reason: nonBlank(4000) }),
  z.strictObject({
    op: z.literal('RECLASSIFY'),
    ...memoryTarget.shape,
    compartments: compartmentRefs,
  }),
]);

export const changeSetSchema = z.strictObject({
  scope_id: uuidSchema,
  operations: z.array(changeOpSchema).min(1).max(64),
});

export const rememberRequestSchema = z.strictObject({
  /** Omitted when the connection can write exactly one scope. */
  scope_id: uuidSchema.optional(),
  memory: memoryInputSchema,
});
export const changeFeedQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  scope_ids: z.array(uuidSchema).max(100).default([]),
  cursor: z.string().max(4096).optional(),
});
export const recallQuerySchema = z.strictObject({
  query: nonBlank(2000),
  scope_ids: z.array(uuidSchema).max(100).default([]),
  subject_ids: z.array(uuidSchema).max(100).optional(),
  memory_ids: z.array(uuidSchema).max(100).optional(),
  mode: z
    .enum(['precise', 'contextual', 'historical', 'exploratory', 'changes'])
    .default('precise'),
  token_budget: z.coerce.number().int().min(64).max(32000).default(4000),
  valid_at: timestampSchema.optional(),
  known_at: timestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Narrows the search to these compartments of the connection's allowance, plus General. */
  compartments: compartmentRefs.optional(),
});

export const captureRequestSchema = z.strictObject({
  scope_id: uuidSchema,
  operation_id: nonBlank(256),
  source: z.strictObject({
    kind: z.enum(['chat', 'document', 'tool_result', 'episode']),
    external_id: nonBlank(512),
    revision: nonBlank(128).default('1'),
  }),
  observations: z
    .array(
      z.strictObject({
        locator: nonBlank(2048),
        content: nonBlank(32_768),
        speaker: z.string().trim().max(256).optional(),
        event_time: timestampSchema.optional(),
        lineage_root: uuidSchema.optional(),
      }),
    )
    .min(1)
    .max(256),
});

export const connectorAuthorizationSchema = z
  .strictObject({
    scope_id: uuidSchema,
    source_kind: z.enum(['chat', 'document', 'tool_result', 'episode']),
    external_id: nonBlank(512),
    enabled: z.boolean(),
    consent: z.boolean(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** The label observations from this source receive; omitted means the default. */
    compartments: compartmentRefs.optional(),
  })
  .refine((value) => !value.enabled || value.consent, {
    message: 'An enabled connector requires explicit consent',
    path: ['consent'],
  });

export const createCompartmentSchema = z.strictObject({ name: nonBlank(100) });
export const narrowAccessSchema = z.strictObject({ compartments: compartmentRefs.min(1) });
export const compartmentAccessRequestSchema = z.strictObject({
  compartments: compartmentRefs.min(1),
});

export const reviewListQuerySchema = z.strictObject({
  scope_id: uuidSchema,
  status: z.enum(['held', 'approved', 'rejected', 'stale']).default('held'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: timestampSchema.optional(),
});

export const reviewDecisionSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  decision: z.enum(['approve', 'reject']),
  confirmation: z.enum(['accept_candidate', 'user_statement']).default('accept_candidate'),
  reason: z.string().trim().max(4000).optional(),
});

export const forgetRequestSchema = z.strictObject({
  scope_id: uuidSchema,
  selector: z
    .strictObject({
      memory_ids: z.array(uuidSchema).max(100).optional(),
      source_ids: z.array(uuidSchema).max(100).optional(),
      subject_ids: z.array(uuidSchema).max(100).optional(),
    })
    .refine(
      (selector) =>
        (selector.memory_ids?.length ?? 0) > 0 ||
        (selector.source_ids?.length ?? 0) > 0 ||
        (selector.subject_ids?.length ?? 0) > 0,
      'At least one non-empty selector is required',
    ),
  reason_code: z.enum(['user_requested', 'source_revoked', 'retention_expired', 'correction']),
});

export const sourceRightsSchema = z.strictObject({
  scope_id: uuidSchema,
  rights_status: z.enum(['granted', 'revoked']),
  consent: z.boolean(),
});

export const grantMutationSchema = z
  .strictObject({
    principal_id: uuidSchema,
    capabilities: z
      .array(z.enum(['read', 'write', 'admin']))
      .min(1)
      .max(3)
      .optional(),
    expires_at: timestampSchema.nullable().optional(),
    revoke: z.boolean().default(false),
  })
  .refine((value) => value.revoke || value.capabilities !== undefined, {
    message: 'capabilities are required unless revoking a grant',
    path: ['capabilities'],
  });

export const memoryFeedbackSchema = z.strictObject({
  scope_id: uuidSchema,
  memory_id: uuidSchema,
  feedback_type: z.enum(['useful', 'incorrect', 'stale', 'not_relevant']),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const exportRequestSchema = z.strictObject({ scope_id: uuidSchema });
export const importRequestSchema = z.strictObject({
  scope_id: uuidSchema,
  encrypted_bundle: z.string().min(1).max(16_000_000),
  grant_imported_sources: z.boolean().default(false),
});
export const retentionPolicySchema = z.strictObject({
  observation_days: z.number().int().min(1).max(36_500),
  memory_days: z.number().int().min(1).max(36_500).nullable().optional(),
});

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    request_id: z.string().uuid(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});

export type ActorKind = z.infer<typeof actorKindSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type ChangeOp = z.infer<typeof changeOpSchema>;
export type ChangeSet = z.infer<typeof changeSetSchema>;
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export type SubjectInput = z.infer<typeof subjectInputSchema>;

/**
 * The compartments an actor may receive and write. A Gate connection carries its allowance: an
 * explicit, possibly empty list (empty means General only) and the epoch it was read at. Worker
 * and system actors carry every compartment of the user; the database still receives an
 * explicit list, never an unrestricted value.
 */
export type CompartmentAccess =
  | { readonly kind: 'allowance'; readonly ids: readonly string[]; readonly epoch: number }
  | { readonly kind: 'all' };

export const allCompartments: CompartmentAccess = Object.freeze({ kind: 'all' });

/** The compartment list, or `'all'`, that an actor's database context must be given. */
export function databaseCompartments(access: CompartmentAccess): readonly string[] | 'all' {
  return access.kind === 'all' ? 'all' : access.ids;
}

export interface ActorContext {
  readonly userId: string;
  readonly principalId: string;
  readonly actorKind: ActorKind;
  readonly scopeIds: readonly string[];
  readonly tokenScopeIds: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly authEpochs: Readonly<Record<string, number>>;
  readonly compartments: CompartmentAccess;
  /** The verified Gate client registration, recorded as provenance only. */
  readonly clientId?: string;
  /**
   * True for a connection principal: an AI connection that acts for the user without the user's
   * authority. It may read what the user can review, but every change it makes stays its own.
   */
  readonly actsForUser?: boolean;
}

export interface CoreErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly retryable: boolean;
    readonly details?: unknown;
  };
}

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CoreError';
  }

  toBody(requestId: string): CoreErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export { encodeIdentityProvenanceV1, decodeIdentityProvenanceV1 } from './identity-v1.js';
