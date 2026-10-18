export interface CloudDeploymentConfig {
  project: string;
  projectNumber: string;
  region: string;
  productDisplayName: string;
  identity: {
    database: string;
    url: string;
    realm: string;
    publicClientId: string;
    smokeClientId: string;
    ownerInitialPasswordSecret: string;
    existing?: { ownerSubjectId?: string };
    migration: {
      sourceRealm: string;
      targetRealm: string;
      sourceApiScopeName: string;
      sourceReadScopeName: string;
      sourceWriteScopeName: string;
      targetScopeIdsScopeName: string;
      scopeRenames: [string, string][];
      sourceAudienceMapperName: string;
      targetAudienceMapperName: string;
      sourceScopeIdsMapperName: string;
      targetScopeIdsMapperName: string;
      mapperNameCutover: {
        realmId: string;
        mappings: MapperNameMapping[];
      };
    };
  };
  taskQueue: {
    name: string;
    invokerServiceAccount: string;
  };
  vertex: {
    location: string;
    extractionModel: string;
    embeddingModel: string;
    embeddingDimension: string;
  };
  [key: string]: unknown;
}

export interface CloudIdentityConfig {
  project: string;
  productDisplayName: string;
  identityUrl: string;
  realm: string;
  ownerSubjectId: string | undefined;
  publicClientId: string;
  smokeClientId: string;
  ownerInitialPasswordSecret: string;
  scopes: {
    scopeIds: string;
    api: string;
    read: string;
    write: string;
  };
}

export interface MapperNameMapping {
  scopeId: string;
  sourceScopeName: string;
  targetScopeName: string;
  mapperId: string;
  sourceMapperName: string;
  targetMapperName: string;
  mapperType: 'oidc-audience-mapper' | 'oidc-usermodel-attribute-mapper';
}

export function readCloudDeploymentConfig(): Promise<CloudDeploymentConfig>;
export function readCloudIdentityConfig(): Promise<CloudIdentityConfig>;
