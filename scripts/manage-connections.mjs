// Manages workspaces and connections of one admitted subject (ADR 0012). Operator tool: it runs
// with Application Default Credentials, or against a loopback FIRESTORE_EMULATOR_HOST when set.
// Build the packages first (`npm run build`). Real project, database and workspace names stay out
// of the repository; pass them on the command line.
import { parseArgs } from 'node:util';
import {
  createFirestoreClient,
  WorkspaceRegistry,
  WorkspaceRegistryError,
} from '@memory/memory-records';

const USAGE = `Usage: node scripts/manage-connections.mjs <command> --project <project-id> --database <database-id> --issuer <issuer> --subject <subject> [options]

Commands:
  init                         Grant the default connection every workspace and the Inbox, and let the worker read every label
  create-workspace             --name <name> [--description <text>]
  set-connection               --connection default|new|<con_id> --workspaces all|<wsp_id,...> [--inbox] [--default-workspace <wsp_id>]
  deactivate-connection        --connection <con_id>
  show                         Print workspaces and connections

Every change accepts --note <text>, recorded in the access history.`;

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      project: { type: 'string' },
      database: { type: 'string' },
      issuer: { type: 'string' },
      subject: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      connection: { type: 'string' },
      workspaces: { type: 'string' },
      inbox: { type: 'boolean', default: false },
      'default-workspace': { type: 'string' },
      note: { type: 'string', default: '' },
    },
    strict: true,
    allowPositionals: true,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : 'Invalid arguments');
}
const { values, positionals } = parsed;
const [command, ...extra] = positionals;
if (command === undefined || extra.length > 0) fail('Give exactly one command');

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
const emulator = emulatorHost !== undefined && emulatorHost !== '';
if (emulator && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):\d{1,5}$/u.test(emulatorHost)) {
  fail('FIRESTORE_EMULATOR_HOST must be a loopback host:port');
}
const { project, database, issuer, subject } = values;
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) {
  fail('--project must be a GCP project ID');
}
if (!database || !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(database)) {
  fail('--database must be the named Memory Records database');
}
if (!issuer || !subject) fail('--issuer and --subject name the admission');

const registry = new WorkspaceRegistry(
  createFirestoreClient({ projectId: project, databaseId: database }),
);
const admission = { issuer, subject };

function grantFromArgs() {
  const workspaces = values.workspaces;
  if (!workspaces) fail('--workspaces is required');
  return {
    workspaces:
      workspaces === 'all'
        ? 'all'
        : workspaces
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== ''),
    inbox: values.inbox === true,
    defaultWorkspace: values['default-workspace'] ?? null,
  };
}

try {
  let result;
  switch (command) {
    case 'init':
      result = await registry.initialize(admission, values.note);
      break;
    case 'create-workspace':
      if (!values.name) fail('--name is required');
      result = await registry.createWorkspace(admission, {
        name: values.name,
        description: values.description ?? '',
        note: values.note,
      });
      break;
    case 'set-connection':
      if (!values.connection) fail('--connection is required');
      result = await registry.setConnection(
        admission,
        values.connection,
        grantFromArgs(),
        values.note,
      );
      break;
    case 'deactivate-connection':
      if (!values.connection) fail('--connection is required');
      result = await registry.deactivateConnection(admission, values.connection, values.note);
      break;
    case 'show':
      result = {
        workspaces: await registry.listWorkspaces(admission),
        connections: await registry.listConnections(admission),
      };
      break;
    default:
      fail(`Unknown command ${command}`);
  }
  console.log(
    JSON.stringify({ command, target: emulator ? 'emulator' : 'firestore', result }, null, 2),
  );
  process.exit(0);
} catch (error) {
  if (error instanceof WorkspaceRegistryError) {
    console.error(JSON.stringify({ command, error: error.code, message: error.message }));
    process.exit(1);
  }
  throw error;
}
