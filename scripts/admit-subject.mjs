// Creates or reactivates the Lore admission of one Gate subject. Operator tool: it runs with
// Application Default Credentials, or against a loopback FIRESTORE_EMULATOR_HOST when set.
// The admission document ID must match admissionDocumentId in packages/memory-records/src/access.ts.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Firestore } from '@google-cloud/firestore';

const USAGE =
  'Usage: node scripts/admit-subject.mjs --project <project-id> --database <database-id> ' +
  '--issuer <gate-origin> --subject <gate-subject> --tenant <tenant-id> --scope <scope-id>';
const COLLECTION = 'memoryAdmissions';
const APPROVAL_POLICY = 'automatic';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const hasControlCharacter = (value) =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      project: { type: 'string' },
      database: { type: 'string' },
      issuer: { type: 'string' },
      subject: { type: 'string' },
      tenant: { type: 'string' },
      scope: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : 'Invalid arguments');
}

const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
const emulator = emulatorHost !== undefined && emulatorHost !== '';
const loopbackEmulator =
  emulator && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):\d{1,5}$/u.test(emulatorHost);
if (emulator && !loopbackEmulator) fail('FIRESTORE_EMULATOR_HOST must be a loopback host:port');

const { project, database, issuer, subject, tenant, scope } = values;
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) {
  fail('--project must be a GCP project ID');
}
if (!database || !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/u.test(database)) {
  fail('--database must be the named Memory Records database');
}
let issuerUrl;
try {
  issuerUrl = new URL(issuer ?? '');
} catch {
  fail('--issuer must be the Gate issuer origin');
}
const loopbackIssuer = ['127.0.0.1', 'localhost', '[::1]'].includes(issuerUrl.hostname);
if (
  issuer !== issuerUrl.origin ||
  !(
    issuerUrl.protocol === 'https:' ||
    (emulator && loopbackIssuer && issuerUrl.protocol === 'http:')
  )
) {
  fail('--issuer must be the exact HTTPS Gate origin, as configured in GATE_ISSUER');
}
if (!subject || Buffer.byteLength(subject, 'utf8') > 1024 || hasControlCharacter(subject)) {
  fail('--subject must be the Gate subject, such as github:<numeric id>');
}
if (!tenant || !IDENTIFIER.test(tenant)) fail('--tenant must match [A-Za-z0-9][A-Za-z0-9._:-]*');
if (!scope || !IDENTIFIER.test(scope)) fail('--scope must match [A-Za-z0-9][A-Za-z0-9._:-]*');

const documentId = createHash('sha256')
  .update(['lore-admission-v1', issuer, subject].join('\u0000'), 'utf8')
  .digest('hex');

const firestore = new Firestore({
  projectId: project,
  databaseId: database,
  ...(loopbackEmulator
    ? {
        credentials: {
          client_email: 'firestore-emulator@example.test',
          private_key: generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
          }).privateKey,
        },
      }
    : {}),
});

try {
  const ref = firestore.collection(COLLECTION).doc(documentId);
  const outcome = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const now = new Date().toISOString();
    if (!snapshot.exists) {
      transaction.create(ref, {
        active: true,
        issuer,
        tenantId: tenant,
        scopeId: scope,
        approvalPolicy: APPROVAL_POLICY,
        createdAt: now,
        updatedAt: now,
      });
      return { action: 'created' };
    }
    const stored = snapshot.data() ?? {};
    if (stored.issuer !== issuer || stored.tenantId !== tenant || stored.scopeId !== scope) {
      return { action: 'refused', reason: 'admission exists with a different tenant or scope' };
    }
    if (stored.active === true && stored.approvalPolicy === APPROVAL_POLICY) {
      return { action: 'unchanged' };
    }
    transaction.update(ref, { active: true, approvalPolicy: APPROVAL_POLICY, updatedAt: now });
    return {
      action: 'reactivated',
      previous: { active: stored.active === true, approvalPolicy: stored.approvalPolicy ?? null },
    };
  });
  console.log(
    JSON.stringify(
      {
        ...outcome,
        target: emulator ? 'emulator' : 'firestore',
        project,
        database,
        collection: COLLECTION,
        documentId,
        tenantId: tenant,
        scopeId: scope,
        approvalPolicy: APPROVAL_POLICY,
      },
      null,
      2,
    ),
  );
  process.exitCode = outcome.action === 'refused' ? 1 : 0;
} catch (error) {
  console.error(`Admission failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await firestore.terminate();
}
