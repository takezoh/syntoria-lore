import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  openSourceMetadataOperator,
  prepareSourceMetadataMigration,
} from '../packages/memory-records/dist/operator-maintenance.js';

const USAGE =
  'Usage: node scripts/migrate-source-metadata.mjs prepare --snapshot <private.json> --plan <reviewed.json> --project <id> --database <id> --ledger-database <id> --migration-id <id> --output <private.json> [--recorded-at <ISO>]\n' +
  '   or: node scripts/migrate-source-metadata.mjs dry-run|apply|verify --manifest <private.json> --project <id> --database <id> --ledger-database <id> [--approved-digest <sha256>]';

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function privatePath(value) {
  if (!value || !isAbsolute(value)) throw new TypeError('Private file paths must be absolute');
  const path = resolve(value);
  const fromRepository = relative(process.cwd(), path);
  const insideRepository =
    fromRepository !== '' && !fromRepository.startsWith(`..${sep}`) && fromRepository !== '..';
  if (insideRepository && fromRepository.split(sep)[0] !== '.local') {
    throw new TypeError(
      'Snapshot, plan and manifest files must stay outside tracked repository files',
    );
  }
  return path;
}

async function readJson(pathValue, label) {
  try {
    return JSON.parse(await readFile(privatePath(pathValue), 'utf8'));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`Could not read private ${label} JSON`, { cause: error });
  }
}

function options() {
  const parsed = parseArgs({
    options: {
      snapshot: { type: 'string' },
      plan: { type: 'string' },
      manifest: { type: 'string' },
      output: { type: 'string' },
      project: { type: 'string' },
      database: { type: 'string' },
      'ledger-database': { type: 'string' },
      'migration-id': { type: 'string' },
      'recorded-at': { type: 'string' },
      'approved-digest': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  const [command] = parsed.positionals;
  if (!['prepare', 'dry-run', 'apply', 'verify'].includes(command ?? '')) {
    throw new TypeError(USAGE);
  }
  return { command, values: parsed.values };
}

function checkManifest(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new TypeError('Private manifest is invalid');
  }
  const { sha256: supplied, ...body } = value;
  if (sha256(stableJson(body)) !== supplied)
    throw new TypeError('Private manifest digest is invalid');
  return value;
}

function targetFrom(values) {
  const { project, database, 'ledger-database': ledgerDatabase } = values;
  if (!project || !database || !ledgerDatabase)
    throw new TypeError('Explicit project and database flags are required');
  return {
    projectId: project,
    databaseId: database,
    deletionLedgerDatabaseId: ledgerDatabase,
  };
}

function printSummary(command, manifest, result) {
  const sources = manifest.entries.flatMap((entry) =>
    entry.additions.map((addition) => addition.source),
  );
  const summary = {
    command,
    migrationId: manifest.migrationId,
    manifestSha256: manifest.sha256,
    recordCount: manifest.entries.length,
    sourceReferenceCount: sources.length,
    distinctUriCount: new Set(sources.map((source) => source.uri)).size,
    sequence: result.sequence,
    indexedThrough: result.indexedThrough,
    replayed: result.replayed,
    authenticatedOperator: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function main() {
  const { command, values } = options();
  if (command === 'prepare') {
    const target = targetFrom(values);
    const snapshot = await readJson(values['snapshot'], 'snapshot');
    const plan = await readJson(values['plan'], 'reviewed plan');
    if (!values['migration-id'] || !values['output']) throw new TypeError(USAGE);
    const manifest = prepareSourceMetadataMigration(
      snapshot,
      plan,
      target,
      values['migration-id'],
      values['recorded-at'],
    );
    const output = privatePath(values['output']);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const sources = manifest.entries.flatMap((entry) =>
      entry.additions.map((addition) => addition.source),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          command,
          manifestSha256: manifest.sha256,
          recordCount: manifest.entries.length,
          sourceReferenceCount: sources.length,
          distinctUriCount: new Set(sources.map((source) => source.uri)).size,
          output,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const target = targetFrom(values);
  const manifest = checkManifest(await readJson(values['manifest'], 'manifest'));
  if (command === 'apply' && values['approved-digest'] !== manifest.sha256) {
    throw new TypeError('Apply requires --approved-digest equal to the reviewed manifest SHA-256');
  }
  if (values['approved-digest'] && values['approved-digest'] !== manifest.sha256) {
    throw new TypeError('Approved digest does not match the private manifest');
  }
  const operator = await openSourceMetadataOperator(target);
  try {
    const result =
      command === 'dry-run'
        ? await operator.dryRun(manifest)
        : command === 'apply'
          ? await operator.apply(manifest)
          : await operator.verify(manifest);
    printSummary(command, manifest, result);
  } finally {
    await operator.close();
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof TypeError
      ? error.message
      : 'Source metadata migration failed. If apply may have committed before its response was lost, verify the same manifest and target before retrying.';
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}
