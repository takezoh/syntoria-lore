import { describe, expect, it } from 'vitest';
import {
  applyRetract,
  applySupersede,
  deriveAuthority,
  indexEntryFor,
  isMemoryRecord,
  isSourceReference,
  selectCurrentView,
  selectHistoricalView,
  tokenizeSearchText,
  type AuthorizedChange,
  type MemoryRecord,
} from '../packages/memory-records/src/index.js';

const approvedChange: AuthorizedChange = {
  writer: { kind: 'person', id: 'user-1' },
  protectedChange: true,
  approval: { status: 'approved', provenance: 'policy', protectedChangeId: 'change-1' },
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'record-1',
    tenantId: 'tenant-1',
    scopeId: 'scope-1',
    schemaVersion: 1,
    kind: 'decision',
    title: 'Database choice',
    statement: 'Choose after requirements are settled',
    details: {
      kind: 'decision',
      question: 'Which database?',
      choice: 'Wait for requirements',
      reason: 'The requirements are not settled',
      decider: 'user-1',
      decisionTime: '2026-01-01T00:00:00.000Z',
    },
    subjectIds: ['project-1'],
    aliases: [],
    assumptions: [],
    attribution: { speaker: 'user-1', role: 'user' },
    lifecycle: 'active',
    contested: false,
    needsRecheck: false,
    suppressed: false,
    valid: { from: '2026-01-01T00:00:00.000Z', until: null },
    compartmentIds: ['work'],
    supersedes: null,
    supersededBy: null,
    revision: {
      revision: 1,
      changeKind: 'create',
      reason: 'Created from an approved decision',
      writer: { kind: 'person', id: 'user-1' },
      approval: { status: 'approved', provenance: 'person', protectedChangeId: 'change-0' },
      requestingConnectionId: null,
      gateClientId: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
      sourceReferences: [
        { provider: 'chat', accountOrTenant: 'tenant-1', resourceId: 'message-1' },
      ],
    },
    ...overrides,
  };
}

describe('Memory Record value model', () => {
  it('tokenizes normalized terms and Japanese character bigrams deterministically', () => {
    expect(tokenizeSearchText('Memory ＲＥＣＯＲＤＳ 東京で記憶を使う')).toEqual(
      ['memory', 'records', '使う', 'を使', '京で', '東京', '記憶', '憶を', 'で記'].sort(),
    );
  });

  it('records embedding model and dimension and rejects an inconsistent provider vector', () => {
    expect(
      indexEntryFor(record(), { modelId: 'test-model', dimension: 2, values: [0.25, 0.75] }),
    ).toMatchObject({
      recordId: 'record-1',
      revision: 1,
      embedding: { modelId: 'test-model', dimension: 2, values: [0.25, 0.75] },
    });
    expect(() =>
      indexEntryFor(record(), { modelId: 'test-model', dimension: 2, values: [0.25] }),
    ).toThrow(/declared dimension/u);
  });
  it('validates the current record shape and excludes source bodies', () => {
    expect(isMemoryRecord(record())).toBe(true);
    expect(
      isSourceReference({ provider: 'chat', accountOrTenant: 'tenant-1', resourceId: 'message-1' }),
    ).toBe(true);
    expect(
      isSourceReference({
        provider: 'web',
        accountOrTenant: 'example.test',
        resourceId: 'https://example.test/doc',
        uri: 'https://example.test/doc',
        title: 'Reference title',
      }),
    ).toBe(true);
    const longSourceTitle = {
      provider: 'web',
      accountOrTenant: 'example.test',
      resourceId: 'https://example.test/doc',
      uri: 'https://example.test/doc',
      title: 'x'.repeat(201),
    };
    expect(isSourceReference(longSourceTitle)).toBe(false);
    expect(
      isMemoryRecord({
        ...record(),
        revision: { ...record().revision, sourceReferences: [longSourceTitle] },
      }),
    ).toBe(false);
    expect(isMemoryRecord({ ...record(), originalBody: 'original source text' })).toBe(false);
    expect(
      isMemoryRecord({
        ...record(),
        details: { ...record().details, sourceText: 'original source text' },
      }),
    ).toBe(false);
    expect(
      isMemoryRecord({
        ...record(),
        revision: {
          ...record().revision,
          recordedAt: 'March 1, 2026',
        },
      }),
    ).toBe(false);
    expect(
      isMemoryRecord({
        ...record(),
        revision: {
          ...record().revision,
          recordedAt: '2026-03-01T00:00:00',
        },
      }),
    ).toBe(false);
    const withBody = record({
      revision: {
        ...record().revision,
        sourceReferences: [
          {
            provider: 'chat',
            accountOrTenant: 'tenant-1',
            resourceId: 'message-1',
            body: 'raw text',
          } as never,
        ],
      },
    });
    expect(isMemoryRecord(withBody)).toBe(false);
    for (const field of ['content', 'rawText']) {
      const sourceReference = {
        provider: 'chat',
        accountOrTenant: 'tenant-1',
        resourceId: 'message-1',
        [field]: 'original source text',
      };
      expect(
        isMemoryRecord({
          ...record(),
          revision: { ...record().revision, sourceReferences: [sourceReference] },
        }),
      ).toBe(false);
    }
    expect(
      isMemoryRecord({ ...record(), details: { kind: 'fact', subject: 'x', claim: 'y' } }),
    ).toBe(false);
  });

  it('keeps an AI proposal separate from user authority and preserves approval provenance', () => {
    expect(
      deriveAuthority({
        writer: { kind: 'ai', id: 'assistant-1', connectionId: 'connection-1' },
        protectedChange: false,
        approval: { status: 'none' },
      }),
    ).toBe('proposal');
    expect(deriveAuthority(approvedChange)).toBe('user');
    expect(record().revision.approval.provenance).toBe('person');
  });

  it('applies a future-effective supersede without changing the earlier interval before its start', () => {
    const next = record({
      id: 'record-2',
      title: 'Updated database choice',
      valid: { from: '2026-07-01T00:00:00.000Z', until: null },
      revision: {
        ...record().revision,
        revision: 1,
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
    });
    const result = applySupersede(
      record(),
      next,
      '2026-07-01T00:00:00.000Z',
      'Requirements were settled',
      '2026-02-01T00:00:00.000Z',
      approvedChange,
    );
    expect(result.previous.valid.until).toBe('2026-07-01T00:00:00.000Z');
    expect(result.previous.supersededBy).toBe('record-2');
    expect(result.previous.revision.revision).toBe(2);
    expect(result.replacement.supersedes).toBe('record-1');
    expect(
      selectHistoricalView(
        [record(), result.previous],
        '2026-03-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      )?.id,
    ).toBe('record-1');
    expect(
      selectHistoricalView(
        [record(), result.previous],
        '2026-03-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('retracts a mistake without closing its valid interval and increments its revision', () => {
    const retracted = applyRetract(
      record(),
      'The source was misunderstood',
      '2026-03-01T00:00:00.000Z',
      approvedChange,
    );
    expect(retracted.lifecycle).toBe('retracted');
    expect(retracted.valid).toEqual(record().valid);
    expect(retracted.revision.revision).toBe(2);
    expect(retracted.revision.changeKind).toBe('retract');
    expect(retracted.revision.reason).toBe('The source was misunderstood');
  });

  it('selects by known-at first, then valid-at, without falling back to an older revision', () => {
    const initial = record();
    const laterRevision = record({
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-02-01T00:00:00.000Z',
      },
      valid: { from: '2026-07-01T00:00:00.000Z', until: null },
    });
    expect(
      selectHistoricalView(
        [initial, laterRevision],
        '2026-01-15T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
      )?.revision.revision,
    ).toBe(1);
    expect(
      selectHistoricalView(
        [initial, laterRevision],
        '2026-03-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('never selects forgotten content in current or historical time', () => {
    expect(
      selectCurrentView([record({ suppressed: true })], '2026-03-01T00:00:00.000Z'),
    ).toBeNull();
    expect(
      selectHistoricalView(
        [record({ suppressed: true })],
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toBeNull();
    const forgottenLater = record({
      revision: {
        ...record().revision,
        revision: 2,
        changeKind: 'refine',
        recordedAt: '2026-04-01T00:00:00.000Z',
      },
      suppressed: true,
    });
    expect(
      selectHistoricalView(
        [record(), forgottenLater],
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  it('keeps proposal selection opt-in for generic views and supports recall selectors', () => {
    const candidate = record({
      lifecycle: 'candidate',
      attribution: { speaker: null, role: 'ai' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-1', connectionId: 'connection-1' },
        approval: { status: 'none' },
      },
    });
    expect(selectCurrentView([candidate], '2026-03-01T00:00:00.000Z')).toBeNull();
    expect(
      selectHistoricalView([candidate], '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    ).toBeNull();
    expect(
      selectCurrentView([candidate], '2026-03-01T00:00:00.000Z', { includeProposals: true }),
    ).toEqual(candidate);
    expect(
      selectHistoricalView([candidate], '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', {
        includeProposals: true,
      }),
    ).toEqual(candidate);
  });

  it('makes the explicit proposal opt-out match derived authority on active AI records', () => {
    const activeProposal = record({
      lifecycle: 'active',
      attribution: { speaker: null, role: 'ai' },
      revision: {
        ...record().revision,
        writer: { kind: 'ai', id: 'assistant-1', connectionId: 'connection-1' },
        approval: { status: 'none' },
      },
    });
    expect(
      selectHistoricalView(
        [activeProposal],
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toEqual(activeProposal);
    expect(
      selectHistoricalView(
        [activeProposal],
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
        { includeProposals: false },
      ),
    ).toBeNull();
  });

  it('refuses supersede and retract when the approval path does not derive user authority', () => {
    const proposal: AuthorizedChange = {
      writer: { kind: 'ai', id: 'assistant-1', connectionId: 'connection-1' },
      protectedChange: false,
      approval: { status: 'none' },
    };
    expect(() => applyRetract(record(), 'Wrong', '2026-03-01T00:00:00.000Z', proposal)).toThrow(
      'Retract requires user authority',
    );
    expect(() =>
      applySupersede(
        record(),
        record({ id: 'record-2', valid: { from: '2026-07-01T00:00:00.000Z', until: null } }),
        '2026-07-01T00:00:00.000Z',
        'Updated',
        '2026-03-01T00:00:00.000Z',
        proposal,
      ),
    ).toThrow('Supersede requires user authority');
  });

  it('refuses supersede and retract by an AI writer even when approval provenance is present', () => {
    const aiWriterWithPolicyApproval: AuthorizedChange = {
      writer: { kind: 'ai', id: 'assistant-1', connectionId: 'connection-1' },
      protectedChange: true,
      approval: { status: 'approved', provenance: 'policy', protectedChangeId: 'change-2' },
    };
    expect(() =>
      applyRetract(record(), 'Wrong', '2026-03-01T00:00:00.000Z', aiWriterWithPolicyApproval),
    ).toThrow('Retract requires a person writer');
    expect(() =>
      applySupersede(
        record(),
        record({ id: 'record-2', valid: { from: '2026-07-01T00:00:00.000Z', until: null } }),
        '2026-07-01T00:00:00.000Z',
        'Updated',
        '2026-03-01T00:00:00.000Z',
        aiWriterWithPolicyApproval,
      ),
    ).toThrow('Supersede requires a person writer');
  });

  it('rejects conflicting record histories rather than choosing an arbitrary revision', () => {
    expect(() =>
      selectHistoricalView(
        [record(), record({ id: 'other-record', revision: { ...record().revision, revision: 2 } })],
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ),
    ).toThrow('A revision series must belong to one record, tenant, and scope');
  });
});
