#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCloudBoundaryReadbacks } from './cloud-boundary-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const { inputDirectory, contractPath } = parseArguments(process.argv.slice(2));
  // infra/cloud/iam-contract.json is a synthetic example; the production contract is ignored.
  const config = JSON.parse(
    await readFile(
      resolve(contractPath ?? join(repositoryRoot, '.local/cloud/iam-contract.json')),
      'utf8',
    ),
  );
  const readbacks = await loadReadbacks(inputDirectory, config.readbackFiles);
  const result = verifyCloudBoundaryReadbacks(config, readbacks);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown verification error';
  process.stderr.write(`Cloud boundary verification failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const usage =
    'Usage: verify-cloud-boundaries.mjs --input-dir <absolute-readback-directory> [--contract <iam-contract.json>]';
  let inputDirectory;
  let contractPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--input-dir') inputDirectory = args[++index];
    else if (args[index] === '--contract') contractPath = args[++index];
    else throw new Error(usage);
  }
  if (inputDirectory === undefined || contractPath === '') throw new Error(usage);
  if (!isAbsolute(inputDirectory)) throw new Error('--input-dir must be an absolute path');
  return { inputDirectory: resolve(inputDirectory), contractPath };
}

async function loadReadbacks(inputDirectory, files) {
  const realInput = await realpath(inputDirectory);
  const entries = Object.entries(files);
  const values = await Promise.all(
    entries.map(async ([key, fileName]) => {
      const path = join(realInput, fileName);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`${fileName} must be a regular non-symlink file`);
      }
      try {
        return [key, JSON.parse(await readFile(path, 'utf8'))];
      } catch (error) {
        throw new Error(`${fileName} could not be read as JSON`, { cause: error });
      }
    }),
  );
  return Object.fromEntries(values);
}
