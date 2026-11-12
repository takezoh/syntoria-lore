export type EmbeddingConfig =
  | {
      readonly provider: 'vertex';
      readonly projectId: string;
      readonly location: string;
      readonly model: string;
      readonly dimension: number;
    }
  | { readonly provider: 'deterministic' };

export interface ApiConfig {
  readonly access?: {
    readonly issuer: string;
    readonly audience: string;
    readonly ownerEmail: string;
    /** Existing admission coordinates, not a credential or a token claim. */
    readonly admissionIssuer: string;
    readonly admissionSubject: string;
  };
  readonly port: number;
  readonly firestoreProjectId: string;
  readonly firestoreDatabaseId: string;
  readonly ledgerDatabaseId: string;
  /** The Gate issuer origin. */
  readonly gateIssuer: string;
  /** The exact public `/mcp` URL; tokens must be introspected for this audience. */
  readonly mcpResourceUrl: string;
  /** Hosts accepted in the Host header of `/mcp` requests. */
  readonly mcpAllowedHosts: readonly string[];
  readonly gateClientId: string;
  readonly gateClientSecret: string;
  readonly cursorKeyId: string;
  /** The active cursor signing key. */
  readonly cursorSecret: Buffer;
  readonly embedding: EmbeddingConfig;
  readonly recallAssessment?: {
    readonly projectId: string;
    readonly location: string;
    readonly model: string;
  };

  /** Plain HTTP on loopback for local tests; never in production. */
  readonly allowLoopbackHttp: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u;
const LOCATION = /^[a-z]+-[a-z0-9]+[0-9]$/u;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,62}$/u;
const KEY_ID = /^[a-zA-Z0-9_-]{1,32}$/u;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/**
 * Reads the service configuration from the environment and reports every problem at once.
 * Values are never echoed, so a secret in the wrong variable does not reach the logs.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const problems: string[] = [];
  const production = env['NODE_ENV'] === 'production';
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };
  const matching = (name: string, pattern: RegExp, description: string): string => {
    const value = required(name);
    if (value !== '' && !pattern.test(value)) problems.push(`${name} must be ${description}`);
    return value;
  };

  const loopbackFlag = env['ALLOW_LOOPBACK_HTTP'];
  if (loopbackFlag !== undefined && loopbackFlag !== '0' && loopbackFlag !== '1') {
    problems.push('ALLOW_LOOPBACK_HTTP must be 0 or 1');
  }
  const allowLoopbackHttp = loopbackFlag === '1';
  if (allowLoopbackHttp && production) {
    problems.push('ALLOW_LOOPBACK_HTTP is forbidden when NODE_ENV is production');
  }

  let port = 8080;
  if (env['PORT'] !== undefined) {
    port = Number(env['PORT']);
    if (!/^\d{1,5}$/u.test(env['PORT']) || port < 1 || port > 65_535) {
      problems.push('PORT must be an integer from 1 to 65535');
    }
  }

  const firestoreProjectId = matching('FIRESTORE_PROJECT_ID', PROJECT_ID, 'a GCP project ID');
  const firestoreDatabaseId = matching(
    'FIRESTORE_DATABASE_ID',
    DATABASE_ID,
    'a named Firestore database ID',
  );
  const ledgerDatabaseId = matching(
    'LEDGER_DATABASE_ID',
    DATABASE_ID,
    'a named Firestore database ID',
  );
  if (firestoreDatabaseId !== '' && firestoreDatabaseId === ledgerDatabaseId) {
    problems.push('LEDGER_DATABASE_ID must differ from FIRESTORE_DATABASE_ID');
  }

  const accessEnabled = env['ACCESS_ISSUER'] !== undefined;
  const access = accessEnabled
    ? {
        issuer: required('ACCESS_ISSUER'),
        audience: required('ACCESS_AUDIENCE'),
        ownerEmail: required('ACCESS_OWNER_EMAIL'),
        admissionIssuer: required('OWNER_ADMISSION_ISSUER'),
        admissionSubject: required('OWNER_ADMISSION_SUBJECT'),
      }
    : undefined;
  if (access !== undefined) {
    const url = parseUrl(access.issuer);
    if (url === null || url.protocol !== 'https:' || access.issuer !== url.origin) {
      problems.push('ACCESS_ISSUER must be an exact HTTPS origin');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(access.ownerEmail)) {
      problems.push('ACCESS_OWNER_EMAIL must be an email address');
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(access.audience)) {
      problems.push('ACCESS_AUDIENCE must be one application audience');
    }
    if (
      [access.admissionIssuer, access.admissionSubject].some(
        (value) => value.length > 1024 || hasControlCharacter(value),
      )
    ) {
      problems.push('Owner admission coordinates must be short printable values');
    }
  }
  const gateIssuer = access?.issuer ?? required('GATE_ISSUER');
  if (gateIssuer !== '') {
    const url = parseUrl(gateIssuer);
    if (
      url === null ||
      !allowedScheme(url, allowLoopbackHttp) ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      gateIssuer !== url.origin
    ) {
      problems.push('GATE_ISSUER must be an HTTPS origin without a path or trailing slash');
    }
  }

  const mcpResourceUrl = required('MCP_RESOURCE_URL');
  let resourceHost = '';
  if (mcpResourceUrl !== '') {
    const url = parseUrl(mcpResourceUrl);
    if (
      url === null ||
      !allowedScheme(url, allowLoopbackHttp) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.endsWith('/mcp') ||
      url.href !== mcpResourceUrl
    ) {
      problems.push(
        'MCP_RESOURCE_URL must be the exact HTTPS URL of the /mcp endpoint, without query or fragment',
      );
    } else {
      resourceHost = url.host;
    }
  }
  const extraHosts = (env['MCP_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
  if (
    extraHosts.some((value) => !/^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/u.test(value))
  ) {
    problems.push('MCP_ALLOWED_HOSTS must be a comma-separated list of host[:port] values');
  }

  const gateClientId = accessEnabled ? '' : required('GATE_MCP_CLIENT_ID');
  const gateClientSecret = accessEnabled ? '' : required('GATE_MCP_CLIENT_SECRET');
  for (const [name, value] of [
    ['GATE_MCP_CLIENT_ID', gateClientId],
    ['GATE_MCP_CLIENT_SECRET', gateClientSecret],
  ] as const) {
    if (value !== '' && (value.length > 4096 || hasControlCharacter(value))) {
      problems.push(`${name} must be printable and at most 4096 characters`);
    }
  }

  const cursor = parseCursorKeys(env, problems);

  let embedding: EmbeddingConfig = { provider: 'deterministic' };
  const provider = env['EMBEDDING_PROVIDER'] ?? 'vertex';
  if (provider === 'deterministic') {
    if (production) {
      problems.push('EMBEDDING_PROVIDER=deterministic is forbidden when NODE_ENV is production');
    }
  } else if (provider === 'vertex') {
    const projectId = matching('VERTEX_PROJECT_ID', PROJECT_ID, 'a GCP project ID');
    const location = matching(
      'VERTEX_LOCATION',
      LOCATION,
      'a regional location such as asia-southeast1',
    );
    const model = matching('EMBEDDING_MODEL', MODEL, 'a Vertex AI embedding model ID');
    let dimension = 768;
    if (env['EMBEDDING_DIMENSION'] !== undefined) {
      dimension = Number(env['EMBEDDING_DIMENSION']);
      if (!/^\d{1,4}$/u.test(env['EMBEDDING_DIMENSION']) || dimension < 1 || dimension > 3072) {
        problems.push('EMBEDDING_DIMENSION must be an integer from 1 to 3072');
      }
    }
    embedding = { provider: 'vertex', projectId, location, model, dimension };
  } else {
    problems.push('EMBEDDING_PROVIDER must be vertex or deterministic');
  }

  let recallAssessment: ApiConfig['recallAssessment'];
  if (env['RECALL_ASSESSMENT_MODEL'] !== undefined) {
    const model = matching('RECALL_ASSESSMENT_MODEL', MODEL, 'a Vertex model ID');
    if (embedding.provider !== 'vertex')
      problems.push('RECALL_ASSESSMENT_MODEL requires Vertex configuration');
    else recallAssessment = { projectId: embedding.projectId, location: embedding.location, model };
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    ...(access === undefined ? {} : { access }),
    port,
    firestoreProjectId,
    firestoreDatabaseId,
    ledgerDatabaseId,
    gateIssuer,
    mcpResourceUrl,
    mcpAllowedHosts: [...new Set([resourceHost.toLowerCase(), ...extraHosts])],
    gateClientId,
    gateClientSecret,
    cursorKeyId: cursor.keyId,
    cursorSecret: cursor.secret,
    embedding,
    ...(recallAssessment === undefined ? {} : { recallAssessment }),
    allowLoopbackHttp,
  };
}

/**
 * The cursor key ring: `CURSOR_HMAC_KEYS` holds comma-separated `key-id=base64url` entries of at
 * least 32 bytes each, and `CURSOR_HMAC_ACTIVE_KEY` names the key that signs cursors.
 */
function parseCursorKeys(
  env: Readonly<Record<string, string | undefined>>,
  problems: string[],
): { keyId: string; secret: Buffer } {
  const raw = env['CURSOR_HMAC_KEYS'];
  const active = env['CURSOR_HMAC_ACTIVE_KEY'];
  if (raw === undefined || raw.trim() === '' || active === undefined || active.trim() === '') {
    problems.push('CURSOR_HMAC_KEYS and CURSOR_HMAC_ACTIVE_KEY are required');
    return { keyId: '', secret: Buffer.alloc(0) };
  }
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    const id = separator < 1 ? '' : entry.slice(0, separator);
    const encoded = separator < 1 ? '' : entry.slice(separator + 1);
    const key = Buffer.from(encoded, 'base64url');
    if (
      !KEY_ID.test(id) ||
      !/^[A-Za-z0-9_-]+={0,2}$/u.test(encoded) ||
      key.length < 32 ||
      keys.has(id)
    ) {
      problems.push(
        'CURSOR_HMAC_KEYS must hold unique key-id=base64url entries of at least 32 bytes each',
      );
      return { keyId: '', secret: Buffer.alloc(0) };
    }
    keys.set(id, key);
  }
  const secret = keys.get(active);
  if (secret === undefined) {
    problems.push('CURSOR_HMAC_ACTIVE_KEY must name a key in CURSOR_HMAC_KEYS');
    return { keyId: '', secret: Buffer.alloc(0) };
  }
  return { keyId: active, secret };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function allowedScheme(url: URL, allowLoopbackHttp: boolean): boolean {
  return (
    url.protocol === 'https:' ||
    (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  );
}
