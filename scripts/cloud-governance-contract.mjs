import { LEGACY_PORTABILITY_MIME_TYPE } from '@memory/contracts';

export function requireGovernanceHttpStatus(actual, expected, operation) {
  if (actual !== expected) {
    throw new Error(`${operation} returned HTTP ${actual}`);
  }
}

export function requireRememberedMemoryId(body) {
  const operations = body?.operations;
  if (!Array.isArray(operations)) throw new Error('Remember response omitted operations');
  for (const operation of operations) {
    const ids = operation?.memory_ids;
    if (Array.isArray(ids) && typeof ids[0] === 'string') return ids[0];
  }
  throw new Error('Remember response omitted the synthetic memory ID');
}

export function requireExportAccepted(status, body) {
  requireGovernanceHttpStatus(status, 202, 'synthetic scope export request');
  if (typeof body?.export_id !== 'string' || body.export_id.length === 0) {
    throw new Error('Synthetic scope export request omitted its ID');
  }
  return body.export_id;
}

export function requireExportReady(body) {
  if (body?.state !== 'ready' || body?.content_available !== true) {
    throw new Error('Synthetic scope export did not become available');
  }
}

export function requireEncryptedExport(responseStatus, contentType, bundle) {
  requireGovernanceHttpStatus(responseStatus, 200, 'encrypted export download');
  if (contentType !== LEGACY_PORTABILITY_MIME_TYPE) {
    throw new Error('Encrypted export response has an unexpected content type');
  }
  if (typeof bundle !== 'string' || !bundle.startsWith('v1.')) {
    throw new Error('Export bundle format was unexpected');
  }
}

export function requireImportedMemoryId(body, sourceMemoryId) {
  if (body?.state !== 'complete') throw new Error('Cross-user encrypted import did not complete');
  const idMap = body.id_map;
  if (idMap === null || typeof idMap !== 'object' || Array.isArray(idMap)) {
    throw new Error('Cross-user import omitted its entity ID map');
  }
  const target = idMap[`memories:${sourceMemoryId}`];
  if (typeof target !== 'string')
    throw new Error('Cross-user import omitted the destination memory ID');
  return target;
}

export function requireRecallIncludesMemory(status, body, memoryId) {
  requireGovernanceHttpStatus(status, 200, 'destination Recall');
  const matches = body?.matches;
  if (
    !Array.isArray(matches) ||
    !matches.some((match) => isRecord(match) && match.id === memoryId)
  ) {
    throw new Error('Destination scope Recall did not find the imported memory');
  }
}

export function requireDurableForgetAccepted(body) {
  if (
    body?.ledger_durable !== true ||
    body?.content_available !== false ||
    typeof body?.forget_request_id !== 'string'
  ) {
    throw new Error('Forget did not durably suppress the synthetic copy');
  }
  return body.forget_request_id;
}

export function requireForgetComplete(body) {
  if (body?.status !== 'complete' || body?.content_available !== false) {
    throw new Error('Forget did not reach physical purge completion');
  }
}

export function requireForgottenExportRemoved(status) {
  if (![403, 404, 410].includes(status)) {
    throw new Error(`Forgotten export returned unexpected HTTP ${status}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
