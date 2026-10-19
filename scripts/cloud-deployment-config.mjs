import { readFile } from 'node:fs/promises';

let deploymentPromise;

export async function readCloudDeploymentConfig() {
  deploymentPromise ??= readFile(
    new URL('../infra/cloud/deployment.json', import.meta.url),
    'utf8',
  ).then((source) => JSON.parse(source));
  return deploymentPromise;
}
