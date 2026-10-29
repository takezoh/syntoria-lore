import { createHash } from 'node:crypto';

export interface RequestLimitOptions {
  /** Requests per window for one authenticated Gate connection. */
  readonly connectionLimit: number;
  /** Failed authentications per window for one client address. */
  readonly unauthenticatedLimit: number;
  readonly windowMs?: number;
  /** How long a credential that verified once may bypass an exhausted unauthenticated budget. */
  readonly verifiedTtlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface Window {
  start: number;
  count: number;
}

/**
 * Request budgets that keep unauthenticated traffic from spending the budget of an authenticated
 * connection. Authenticated requests count per Gate connection. Failed authentications count per
 * client address; once an address has used its budget, only a credential that verified recently
 * is still sent for verification. Admission never authorizes: every admitted request is verified.
 */
export class RequestLimits {
  private readonly connections = new Map<string, Window>();
  private readonly failures = new Map<string, Window>();
  private readonly verified = new Map<string, number>();
  private readonly windowMs: number;
  private readonly verifiedTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: RequestLimitOptions) {
    this.windowMs = options.windowMs ?? 60_000;
    this.verifiedTtlMs = options.verifiedTtlMs ?? 600_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Before verification: whether this credential from this address may be verified now. */
  admitCredential(address: string, credential: string | undefined): boolean {
    const now = this.now();
    if (credential !== undefined) {
      const expiresAt = this.verified.get(fingerprint(credential));
      if (expiresAt !== undefined && expiresAt > now) return true;
    }
    const window = this.current(this.failures, address, now);
    return window.count < this.options.unauthenticatedLimit;
  }

  recordFailure(address: string): void {
    this.current(this.failures, address, this.now()).count += 1;
  }

  recordVerified(credential: string): void {
    const now = this.now();
    this.verified.delete(fingerprint(credential));
    this.verified.set(fingerprint(credential), now + this.verifiedTtlMs);
    this.prune(this.verified, (expiresAt) => expiresAt <= now);
  }

  /** After verification: counts the request against its connection's budget. */
  admitConnection(connection: string): boolean {
    const window = this.current(this.connections, connection, this.now());
    window.count += 1;
    return window.count <= this.options.connectionLimit;
  }

  private current(windows: Map<string, Window>, key: string, now: number): Window {
    let window = windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      windows.delete(key);
      window = { start: now, count: 0 };
      windows.set(key, window);
      this.prune(windows, (entry) => now - entry.start >= this.windowMs);
    }
    return window;
  }

  /** Bounds memory: drops expired entries, then the oldest ones, beyond the entry limit. */
  private prune<T>(entries: Map<string, T>, expired: (value: T) => boolean): void {
    if (entries.size <= this.maxEntries) return;
    for (const [key, value] of entries) if (expired(value)) entries.delete(key);
    for (const key of entries.keys()) {
      if (entries.size <= this.maxEntries) break;
      entries.delete(key);
    }
  }
}

function fingerprint(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url');
}
