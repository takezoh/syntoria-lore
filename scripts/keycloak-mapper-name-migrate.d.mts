import type { MapperNameMapping } from './cloud-identity-config.mjs';

export interface MapperNameBaseline {
  formatVersion: 1;
  profile: {
    keycloakVersion: string;
    keycloakImage: string;
    schemaSha256: string;
    changelogSha256: string;
    changelogCount: number;
  };
  databaseIdentity: {
    database: string;
    databaseOid: string;
    serverVersionNum: number;
    systemIdentifier: string;
  };
  realmRows: Array<Record<string, unknown>>;
  clientIds: string[];
  clientScopeRows: Array<Record<string, unknown>>;
  protocolMapperRows: Array<Record<string, unknown>>;
  protocolMapperConfigRows: Array<Record<string, unknown>>;
}

export interface MapperNameCutoverDefinition {
  database: string;
  keycloakVersion: string;
  keycloakImage: string;
  sourceRealm: string;
  targetRealm: string;
  realmId: string;
  mappings: MapperNameMapping[];
  baseline?: MapperNameBaseline;
}

export interface MapperNameCutoverConfig extends MapperNameCutoverDefinition {
  baseline: MapperNameBaseline;
}

export interface MapperNameCutoverResult {
  status: 'applied' | 'already-applied';
  direction: 'forward' | 'reverse';
  mapperCount: number;
  updatedCount: number;
  mapperIdsPreserved: true;
  mapperConfigsPreserved: true;
  databaseAdmissionRestored: true;
}

export interface MapperNameMaintenancePool {
  connect(): Promise<{
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
    release(error?: Error): void;
  }>;
}

export function configuredCutoverConfig(
  deployment: unknown,
  baseline?: MapperNameBaseline,
): MapperNameCutoverDefinition;
export function runMapperNameCutover(
  pool: MapperNameMaintenancePool,
  controlPool: MapperNameMaintenancePool,
  config: MapperNameCutoverConfig,
  direction?: 'forward' | 'reverse',
): Promise<MapperNameCutoverResult>;
export function captureMapperNameBaseline(
  pool: MapperNameMaintenancePool,
  controlPool: MapperNameMaintenancePool,
  config: MapperNameCutoverDefinition,
): Promise<MapperNameBaseline>;
export function readMapperNameBaseline(filePath: string): Promise<MapperNameBaseline>;
export function writeMapperNameBaseline(
  filePath: string,
  baseline: MapperNameBaseline,
): Promise<void>;
