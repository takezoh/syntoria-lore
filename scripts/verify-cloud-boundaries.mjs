#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCloudBoundaryReadbacks } from './cloud-boundary-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(join(repositoryRoot, 'infra/cloud/iam-contract.json'), 'utf8'),
);

try {
  const inputDirectory = parseArguments(process.argv.slice(2));
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
  if (args.length !== 2 || args[0] !== '--input-dir') {
    throw new Error('Usage: verify-cloud-boundaries.mjs --input-dir <absolute-readback-directory>');
  }
  if (!isAbsolute(args[1])) throw new Error('--input-dir must be an absolute path');
  return resolve(args[1]);
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
