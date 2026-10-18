import { describe, expect, it } from 'vitest';
import { LEGACY_PORTABILITY_MIME_TYPE } from '@memory/contracts';
import {
  requireDurableForgetAccepted,
  requireEncryptedExport,
  requireExportAccepted,
  requireExportReady,
  requireForgottenExportRemoved,
  requireForgetComplete,
  requireGovernanceHttpStatus,
  requireImportedMemoryId,
  requireRecallIncludesMemory,
  requireRememberedMemoryId,
} from '../scripts/cloud-governance-contract.mjs';

describe('cloud governance smoke response contract', () => {
  it('extracts IDs only from accepted synthetic operations', () => {
    expect(
      requireRememberedMemoryId({
        operations: [{ memory_ids: ['memory-source'] }],
      }),
    ).toBe('memory-source');
    expect(() => requireRememberedMemoryId({ operations: [] })).toThrow(/memory ID/);
  });

  it('requires the export request and downloadable artifact to be accepted and encrypted', () => {
    expect(requireExportAccepted(202, { export_id: 'export-1' })).toBe('export-1');
    expect(() => requireExportAccepted(200, { export_id: 'export-1' })).toThrow(/HTTP 200/);
    expect(() => requireExportAccepted(202, {})).toThrow(/omitted its ID/);

    expect(() => requireExportReady({ state: 'ready', content_available: true })).not.toThrow();
    expect(() => requireExportReady({ state: 'failed', content_available: false })).toThrow(
      /did not become available/,
    );
    expect(() =>
      requireEncryptedExport(200, LEGACY_PORTABILITY_MIME_TYPE, 'v1.payload'),
    ).not.toThrow();
    expect(() => requireEncryptedExport(503, 'text/plain', 'error')).toThrow(/HTTP 503/);
    expect(() => requireEncryptedExport(200, 'application/json', 'v1.payload')).toThrow(
      /content type/,
    );
    expect(() => requireEncryptedExport(200, LEGACY_PORTABILITY_MIME_TYPE, 'plain')).toThrow(
      /format/,
    );
  });

  it('requires a complete cross-user import and a destination Recall hit', () => {
    expect(
      requireImportedMemoryId(
        { state: 'complete', id_map: { 'memories:source-1': 'destination-1' } },
        'source-1',
      ),
    ).toBe('destination-1');
    expect(() =>
      requireImportedMemoryId(
        { state: 'held', id_map: { 'memories:source-1': 'destination-1' } },
        'source-1',
      ),
    ).toThrow(/did not complete/);
    expect(() => requireImportedMemoryId({ state: 'complete', id_map: [] }, 'source-1')).toThrow(
      /ID map/,
    );
    expect(() => requireImportedMemoryId({ state: 'complete', id_map: {} }, 'source-1')).toThrow(
      /destination memory ID/,
    );

    expect(() =>
      requireRecallIncludesMemory(200, { matches: [{ id: 'destination-1' }] }, 'destination-1'),
    ).not.toThrow();
    expect(() => requireRecallIncludesMemory(401, {}, 'destination-1')).toThrow(/HTTP 401/);
    expect(() =>
      requireRecallIncludesMemory(
        200,
        { matches: [], diagnostic: 'destination-1' },
        'destination-1',
      ),
    ).toThrow(/did not find/);
    expect(() =>
      requireRecallIncludesMemory(
        200,
        { matches: [{ id: 'destination-1-extra' }] },
        'destination-1',
      ),
    ).toThrow(/did not find/);
  });

  it('requires durable suppression, completed purge, and removed export artifacts', () => {
    const accepted = {
      ledger_durable: true,
      content_available: false,
      forget_request_id: 'forget-1',
    };
    expect(requireDurableForgetAccepted(accepted)).toBe('forget-1');
    expect(() => requireDurableForgetAccepted({ ...accepted, ledger_durable: false })).toThrow(
      /durably suppress/,
    );
    expect(() => requireDurableForgetAccepted({ ...accepted, content_available: true })).toThrow(
      /durably suppress/,
    );
    expect(() =>
      requireDurableForgetAccepted({ ...accepted, forget_request_id: undefined }),
    ).toThrow(/durably suppress/);

    expect(() =>
      requireForgetComplete({ status: 'complete', content_available: false }),
    ).not.toThrow();
    expect(() => requireForgetComplete({ status: 'failed', content_available: false })).toThrow(
      /purge completion/,
    );
    expect(() => requireForgetComplete({ status: 'complete', content_available: true })).toThrow(
      /purge completion/,
    );

    expect(() => requireForgottenExportRemoved(404)).not.toThrow();
    expect(() => requireForgottenExportRemoved(410)).not.toThrow();
    expect(() => requireForgottenExportRemoved(200)).toThrow(/HTTP 200/);
    expect(() => requireForgottenExportRemoved(500)).toThrow(/HTTP 500/);
  });

  it('fails closed on unexpected HTTP responses', () => {
    expect(() => requireGovernanceHttpStatus(200, 200, 'Recall')).not.toThrow();
    expect(() => requireGovernanceHttpStatus(403, 200, 'Recall')).toThrow(
      /Recall returned HTTP 403/,
    );
  });
});
