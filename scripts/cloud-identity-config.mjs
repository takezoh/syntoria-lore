import { readFile } from 'node:fs/promises';

let deploymentPromise;

export async function readCloudDeploymentConfig() {
  deploymentPromise ??= readFile(
    new URL('../infra/cloud/deployment.json', import.meta.url),
    'utf8',
  ).then((source) => JSON.parse(source));
  return deploymentPromise;
}

export async function readCloudIdentityConfig() {
  const deployment = await readCloudDeploymentConfig();
  const identity = deployment.identity;
  const migration = identity?.migration;
  if (!identity || !migration || typeof identity.realm !== 'string') {
    throw new Error('Cloud identity configuration is incomplete');
  }
  const targetScope = (sourceName) => {
    const pair = migration.scopeRenames?.find((candidate) => candidate[0] === sourceName);
    if (!Array.isArray(pair) || typeof pair[1] !== 'string') {
      throw new Error('Cloud identity scope mapping is incomplete');
    }
    return pair[1];
  };
  return {
    project: deployment.project,
    productDisplayName: deployment.productDisplayName,
    identityUrl: identity.url,
    realm: identity.realm,
    ownerSubjectId: identity.existing?.ownerSubjectId,
    publicClientId: identity.publicClientId,
    smokeClientId: identity.smokeClientId,
    ownerInitialPasswordSecret: identity.ownerInitialPasswordSecret,
    scopes: {
      scopeIds: migration.targetScopeIdsScopeName,
      api: targetScope(migration.sourceApiScopeName),
      read: targetScope(migration.sourceReadScopeName),
      write: targetScope(migration.sourceWriteScopeName),
    },
  };
}
