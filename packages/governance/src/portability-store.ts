import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, open, opendir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LEGACY_PORTABILITY_AAD,
  LEGACY_PORTABILITY_BUNDLE_FORMAT,
  LEGACY_PORTABILITY_HKDF_SALT,
  LEGACY_CLOUD_PORTABILITY_SIGNER_ID,
  LEGACY_LOCAL_PORTABILITY_SIGNER_ID,
} from '@memory/contracts';

const aad = Buffer.from(LEGACY_PORTABILITY_AAD);
const bundlePrefix = LEGACY_PORTABILITY_BUNDLE_FORMAT;

export interface PortabilityStore {
  seal(payload: unknown): string;
  open(bundle: string): unknown;
  write(exportId: string, contents: string, claimToken: string): Promise<string>;
  keyForClaim(exportId: string, claimToken: string): string;
  read(artifactKey: string): Promise<string>;
  remove(artifactKey: string | null): Promise<void>;
}

export class PortabilityCrypto {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;
  private readonly signerId: string;

  constructor(masterKey: string, signerId: string) {
    if (Buffer.byteLength(masterKey) < 32) {
      throw new Error('PORTABILITY_MASTER_KEY must contain at least 32 bytes');
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(signerId))
      throw new Error('PORTABILITY_SIGNER_ID is invalid');
    this.signerId = signerId;
    const salt = Buffer.from(LEGACY_PORTABILITY_HKDF_SALT);
    this.encryptionKey = Buffer.from(hkdfSync('sha256', masterKey, salt, 'encryption', 32));
    this.signingKey = Buffer.from(hkdfSync('sha256', masterKey, salt, 'signature', 32));
  }

  seal(payload: unknown): string {
    const payloadText = canonicalJson(payload);
    const signature = createHmac('sha256', this.signingKey).update(payloadText).digest('base64url');
    const plaintext = Buffer.from(
      canonicalJson({
        format: bundlePrefix,
        signer_id: this.signerId,
        signature,
        payload,
      }),
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  open(bundle: string): unknown {
    const [version, nonceText, tagText, ciphertextText, extra] = bundle.split('.');
    if (
      version !== 'v1' ||
      nonceText === undefined ||
      tagText === undefined ||
      ciphertextText === undefined ||
      extra !== undefined ||
      bundle.length > 16_000_000
    ) {
      throw new Error('Portable bundle envelope is invalid');
    }
    const nonce = decodeBase64Url(nonceText, 12);
    const tag = decodeBase64Url(tagText, 16);
    const ciphertext = decodeBase64Url(ciphertextText, 12_000_000);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    const envelope: unknown = JSON.parse(plaintext);
    if (
      !isSignedEnvelope(envelope) ||
      envelope.format !== bundlePrefix ||
      (envelope.signer_id !== this.signerId &&
        envelope.signer_id !== LEGACY_LOCAL_PORTABILITY_SIGNER_ID &&
        envelope.signer_id !== LEGACY_CLOUD_PORTABILITY_SIGNER_ID)
    ) {
      throw new Error('Portable bundle signer is not trusted by this environment');
    }
    const expected = createHmac('sha256', this.signingKey)
      .update(canonicalJson(envelope.payload))
      .digest();
    const supplied = Buffer.from(envelope.signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error('Portable bundle signature is invalid');
    }
    return envelope.payload;
  }
}

export class LocalPortabilityStore extends PortabilityCrypto implements PortabilityStore {
  constructor(
    private readonly directory: string,
    masterKey: string,
    signerId: string,
  ) {
    super(masterKey, signerId);
    if (directory.length === 0) throw new Error('PORTABILITY_STORAGE_DIR must be set');
  }

  async write(exportId: string, contents: string, claimToken: string): Promise<string> {
    const path = await this.prepareDirectory();
    const normalizedExportId = normalizeExportId(exportId);
    const normalizedClaimToken = normalizeExportId(claimToken);
    const artifactName = this.keyForClaim(normalizedExportId, normalizedClaimToken);
    const finalPath = this.artifactPath(normalizedExportId, normalizedClaimToken);
    const tempPath = join(
      path,
      `.${normalizedExportId}.${normalizedClaimToken}.${randomBytes(12).toString('hex')}.tmp`,
    );
    const file = await open(tempPath, 'wx', 0o600);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, finalPath);
    await syncDirectory(path);
    return artifactName;
  }

  keyForClaim(exportId: string, claimToken: string): string {
    return `${normalizeExportId(exportId)}.${normalizeExportId(claimToken)}.bundle`;
  }

  async read(artifactKey: string): Promise<string> {
    if (!/^[0-9a-f-]{36}(\.[0-9a-f-]{36})?\.bundle$/i.test(artifactKey))
      throw new Error('Portable artifact key is invalid');
    await this.prepareDirectory();
    return readFile(join(this.directory, artifactKey), 'utf8');
  }

  async remove(artifactKey: string | null): Promise<void> {
    if (artifactKey === null || !/^[0-9a-f-]{36}(\.[0-9a-f-]{36})?\.bundle$/i.test(artifactKey))
      return;
    const [rawExportId, rawClaimToken] = artifactKey.slice(0, -'.bundle'.length).split('.');
    if (rawExportId === undefined) return;
    const exportId = normalizeExportId(rawExportId);
    const claimToken = rawClaimToken === undefined ? null : normalizeExportId(rawClaimToken);
    const directory = await this.prepareDirectory();
    const pending: string[] = [];
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const isJobArtifact =
        claimToken === null &&
        (entry.name === `${exportId}.bundle` ||
          new RegExp(`^${exportId}\\.[a-f0-9-]{36}\\.bundle$`).test(entry.name));
      const isClaimArtifact =
        claimToken !== null && entry.name === `${exportId}.${claimToken}.bundle`;
      const temporaryPrefix =
        claimToken === null
          ? `^\\.${exportId}(?:\\.[a-f0-9-]{36})?\\.[a-f0-9]{24}\\.tmp$`
          : `^\\.${exportId}\\.${claimToken}\\.[a-f0-9]{24}\\.tmp$`;
      if (isJobArtifact || isClaimArtifact || new RegExp(temporaryPrefix).test(entry.name)) {
        pending.push(join(directory, entry.name));
        if (pending.length > 1024) break;
      }
    }
    for (const filePath of pending.slice(0, 1024)) await rm(filePath, { force: true });
    await syncDirectory(directory);
    if (pending.length > 1024) {
      // Do not ACK while any matching temporary artifact may remain. The durable DB lease
      // lets a later sweep continue from the next bounded batch.
      throw new Error('Export artifact cleanup exceeded the per-pass file bound');
    }
  }

  private artifactPath(exportId: string, claimToken: string): string {
    return join(this.directory, `${exportId}.${claimToken}.bundle`);
  }

  private async prepareDirectory(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    return this.directory;
  }
}

function normalizeExportId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Export identifier is invalid');
  return value.toLowerCase();
}

function isSignedEnvelope(value: unknown): value is {
  format: string;
  signer_id: string;
  signature: string;
  payload: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['format'] === bundlePrefix &&
    typeof record['signer_id'] === 'string' &&
    typeof record['signature'] === 'string' &&
    record['payload'] !== undefined
  );
}

function decodeBase64Url(value: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Portable bundle encoding is invalid');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.length > maxBytes)
    throw new Error('Portable bundle part is invalid');
  return decoded;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function portabilityPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
