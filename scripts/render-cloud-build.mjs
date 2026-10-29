#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cloud Build configuration for the runtime image. infra/cloud/cloudbuild.yaml is this output
 * for the synthetic example profile; production identifiers come from the ignored profile.
 */
export function renderCloudBuild(config) {
  const image = `${config.artifactRegistry}/${config.imageName}:$BUILD_ID`;
  return [
    `serviceAccount: projects/${config.project}/serviceAccounts/${config.build.serviceAccount}`,
    'timeout: 1800s',
    'options:',
    '  logging: CLOUD_LOGGING_ONLY',
    'steps:',
    '  - name: gcr.io/cloud-builders/docker',
    '    args:',
    '      - build',
    '      - --file=Dockerfile',
    `      - --tag=${image}`,
    '      - .',
    'images:',
    `  - ${image}`,
    '',
  ].join('\n');
}

async function main(args) {
  const usage =
    'Usage: render-cloud-build.mjs --output <absolute-path> [--config <deployment-profile.json>]';
  let output;
  let configPath = join(repositoryRoot, '.local/cloud/deployment.json');
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output') output = args[++index];
    else if (args[index] === '--config') configPath = args[++index];
    else throw new Error(usage);
  }
  if (output === undefined || !isAbsolute(output) || !configPath) throw new Error(usage);
  const fromRoot = relative(repositoryRoot, resolve(output));
  if (
    !fromRoot.startsWith(`..${sep}`) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`.local${sep}`)
  ) {
    throw new Error('A rendered build configuration inside the repository must be under .local/');
  }
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  await writeFile(resolve(output), renderCloudBuild(config), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
