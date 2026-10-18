#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcludedBuildContextPath } from './cloud-build-context-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = parseArguments(process.argv.slice(2));
if (!isAbsolute(outputArgument)) throw new Error('--output-dir must be an absolute path');

const outputDirectory = resolve(outputArgument);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const realOutput = await realpath(outputDirectory);
const relativeOutput = relative(repositoryRoot, realOutput);
if (
  relativeOutput === '' ||
  (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..' && !isAbsolute(relativeOutput))
) {
  throw new Error('Build context must be written outside the repository');
}
if ((await readdir(realOutput)).length !== 0) {
  throw new Error('--output-dir must be an empty directory');
}

const allowlist = [
  'Dockerfile',
  '.dockerignore',
  '.gcloudignore',
  '.prettierignore',
  '.prettierrc.json',
  'eslint.config.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.test.json',
  'vitest.config.ts',
  'apps',
  'packages',
  'scripts',
  'tests',
  'infra/cloud',
  'infra/keycloak',
  'docs/api/openapi.json',
  'docs/eval/cloud-oauth.md',
];
const manifestEntries = [];
for (const relativePath of allowlist) {
  await copyTree(relativePath);
}

manifestEntries.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  format: 'memory-service-cloud-build-source@1',
  fileCount: manifestEntries.length,
  files: manifestEntries,
};
const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(join(realOutput, 'source-manifest.json'), manifestBytes, {
  mode: 0o444,
  flag: 'wx',
});
await freezeDirectories(realOutput);
const snapshotDigest = createHash('sha256').update(manifestBytes).digest('hex');
process.stdout.write(
  `${JSON.stringify({
    outputDirectory: realOutput,
    fileCount: manifestEntries.length,
    manifestSha256: snapshotDigest,
    immutable: true,
  })}\n`,
);

async function copyTree(relativePath) {
  if (isExcludedBuildContextPath(relativePath)) return;
  const sourcePath = join(repositoryRoot, relativePath);
  const destinationPath = join(realOutput, relativePath);
  const entry = await lstat(sourcePath);
  if (entry.isSymbolicLink()) {
    throw new Error(`Build source must not contain symlinks: ${relativePath}`);
  }
  if (entry.isDirectory()) {
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    const children = (await readdir(sourcePath)).sort();
    for (const child of children) await copyTree(join(relativePath, child));
    await chmod(destinationPath, 0o555);
    return;
  }
  if (!entry.isFile()) throw new Error(`Build source contains a non-regular file: ${relativePath}`);

  const bytes = await readFile(sourcePath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, entry.mode & 0o111 ? 0o555 : 0o444);
  manifestEntries.push({
    path: relativePath.split(sep).join('/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
}

async function freezeDirectories(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await freezeDirectories(join(directory, entry.name));
  }
  await chmod(directory, 0o555);
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== '--output-dir') {
    throw new Error('Usage: prepare-cloud-build-context.mjs --output-dir <absolute-path>');
  }
  return args[1];
}
