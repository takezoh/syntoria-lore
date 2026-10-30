import { createHmac, timingSafeEqual } from 'node:crypto';
import { CoreError, uuidSchema } from '@memory/contracts';

/** The allowance a cursor was read under: a connection's epoch and compartments, or all. */
export type CursorCompartments =
  { readonly epoch: number; readonly ids: readonly string[] } | 'all';

export interface CursorState {
  readonly user: string;
  readonly principal: string;
  readonly scopes: readonly string[];
  readonly offsets: Readonly<Record<string, string>>;
  readonly auth_epochs: Readonly<Record<string, number>>;
  readonly compartments: CursorCompartments;
  readonly exp: number;
}

// Signed payload keys are immutable; the public model uses user. Version 2 adds the allowance
// binding `cmp`; a version 1 cursor reads as General only at epoch 0.
interface SignedCursor extends Omit<CursorState, 'user' | 'compartments'> {
  readonly owner: string;
  readonly v: 1 | 2;
  readonly kid: string;
  readonly cmp?: CursorCompartments;
}

export class CursorCodec {
  constructor(
    private readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly lifetimeSeconds = 60 * 60 * 24 * 30,
  ) {
    if (!keys.has(activeKeyId))
      throw new Error('Active cursor key is not present in CURSOR_HMAC_KEYS');
    if (lifetimeSeconds < 60 || lifetimeSeconds > 60 * 60 * 24 * 365) {
      throw new Error('Cursor lifetime must be between one minute and one year');
    }
  }

  static fromEnvironment(): CursorCodec {
    const raw = process.env['CURSOR_HMAC_KEYS'];
    const active = process.env['CURSOR_HMAC_ACTIVE_KEY'];
    if (raw === undefined || active === undefined) {
      throw new Error('CURSOR_HMAC_KEYS and CURSOR_HMAC_ACTIVE_KEY are required');
    }
    const keys = new Map<string, Buffer>();
    for (const entry of raw.split(',')) {
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('CURSOR_HMAC_KEYS must use key-id=base64url entries');
      const id = entry.slice(0, separator);
      const key = Buffer.from(entry.slice(separator + 1), 'base64url');
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || key.length < 32) {
        throw new Error('Each cursor key needs a valid id and at least 32 bytes');
      }
      keys.set(id, key);
    }
    return new CursorCodec(active, keys);
  }

  encode(state: Omit<CursorState, 'exp'>): string {
    const payload: SignedCursor = {
      v: 2,
      kid: this.activeKeyId,
      owner: state.user,
      principal: state.principal,
      offsets: state.offsets,
      auth_epochs: state.auth_epochs,
      scopes: [...state.scopes].sort(),
      cmp: state.compartments,
      exp: Math.floor(Date.now() / 1000) + this.lifetimeSeconds,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.keys.get(this.activeKeyId)!)
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  decode(
    token: string,
    expected: { user: string; principal: string; scopes: readonly string[] },
  ): CursorState {
    if (token.length > 4096)
      throw new CoreError(400, 'invalid_cursor', 'The change cursor is invalid');
    const [body, encodedSignature, extra] = token.split('.');
    if (body === undefined || encodedSignature === undefined || extra !== undefined) {
      throw new CoreError(400, 'invalid_cursor', 'The change cursor is invalid');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new CoreError(400, 'invalid_cursor', 'The change cursor is invalid');
    }
    if (!isCursorPayload(decoded))
      throw new CoreError(400, 'invalid_cursor', 'The change cursor is invalid');
    const key = this.keys.get(decoded.kid);
    if (key === undefined)
      throw new CoreError(400, 'invalid_cursor', 'The change cursor key is no longer valid');
    const expectedSignature = createHmac('sha256', key).update(body).digest();
    const receivedSignature = Buffer.from(encodedSignature, 'base64url');
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw new CoreError(400, 'invalid_cursor', 'The change cursor signature is invalid');
    }
    if (decoded.exp <= Math.floor(Date.now() / 1000)) {
      throw new CoreError(410, 'cursor_expired', 'The change cursor expired', false, {
        resync_required: true,
      });
    }
    const scopes = [...expected.scopes].sort();
    if (
      decoded.owner !== expected.user ||
      decoded.principal !== expected.principal ||
      decoded.scopes.length !== scopes.length ||
      decoded.scopes.some((scope, index) => scope !== scopes[index])
    ) {
      throw new CoreError(
        403,
        'forbidden',
        'The cursor does not match the authorized scope vector',
      );
    }
    return {
      user: decoded.owner,
      principal: decoded.principal,
      scopes: decoded.scopes,
      offsets: decoded.offsets,
      auth_epochs: decoded.auth_epochs,
      compartments: decoded.v === 1 ? { epoch: 0, ids: [] } : decoded.cmp!,
      exp: decoded.exp,
    };
  }
}

function isCursorPayload(value: unknown): value is SignedCursor {
  if (value === null || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (
    (payload['v'] !== 1 && payload['v'] !== 2) ||
    typeof payload['kid'] !== 'string' ||
    typeof payload['owner'] !== 'string'
  )
    return false;
  if (payload['v'] === 2 && !isCursorCompartments(payload['cmp'])) return false;
  if (typeof payload['principal'] !== 'string' || !Array.isArray(payload['scopes'])) return false;
  if (!Number.isSafeInteger(payload['exp']) || typeof payload['exp'] !== 'number') return false;
  if (
    !uuidSchema.safeParse(payload['owner']).success ||
    !uuidSchema.safeParse(payload['principal']).success
  )
    return false;
  if (
    !payload['scopes'].every(
      (scope) => typeof scope === 'string' && uuidSchema.safeParse(scope).success,
    )
  )
    return false;
  const offsets = payload['offsets'];
  const epochs = payload['auth_epochs'];
  if (!isStringRecord(offsets) || !isNumberRecord(epochs)) return false;
  for (const scope of payload['scopes']) {
    if (
      !/^\d+$/.test(offsets[scope] ?? '') ||
      !Number.isSafeInteger(epochs[scope]) ||
      epochs[scope]! < 1
    )
      return false;
  }
  return true;
}

function isCursorCompartments(value: unknown): value is CursorCompartments {
  if (value === 'all') return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(binding['epoch']) &&
    (binding['epoch'] as number) >= 0 &&
    Array.isArray(binding['ids']) &&
    binding['ids'].every((id) => typeof id === 'string' && uuidSchema.safeParse(id).success)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'number')
  );
}
