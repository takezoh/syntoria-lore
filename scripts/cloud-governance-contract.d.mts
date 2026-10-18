export function requireGovernanceHttpStatus(
  actual: number,
  expected: number,
  operation: string,
): void;
export function requireRememberedMemoryId(body: unknown): string;
export function requireExportAccepted(status: number, body: unknown): string;
export function requireExportReady(body: unknown): void;
export function requireEncryptedExport(
  responseStatus: number,
  contentType: string | null,
  bundle: string,
): void;
export function requireImportedMemoryId(body: unknown, sourceMemoryId: string): string;
export function requireRecallIncludesMemory(status: number, body: unknown, memoryId: string): void;
export function requireDurableForgetAccepted(body: unknown): string;
export function requireForgetComplete(body: unknown): void;
export function requireForgottenExportRemoved(status: number): void;
