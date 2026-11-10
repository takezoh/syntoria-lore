import { generateKeyPairSync } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

export interface FirestoreClientOptions {
  readonly projectId: string;
  /** A named database; omitted means `(default)`. */
  readonly databaseId?: string;
}

/**
 * Creates a Firestore client. Outside the emulator it uses Application Default Credentials.
 * With a loopback `FIRESTORE_EMULATOR_HOST` it signs with a throwaway key, so a local run never
 * looks up real credentials.
 */
export function createFirestoreClient(options: FirestoreClientOptions): Firestore {
  const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
  const emulatorUrl = emulatorHost ? new URL(`http://${emulatorHost}`) : undefined;
  const localEmulator =
    emulatorUrl !== undefined && ['127.0.0.1', 'localhost', '[::1]'].includes(emulatorUrl.hostname);
  const emulatorCredentials = localEmulator
    ? generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey
    : undefined;
  return new Firestore({
    projectId: options.projectId,
    ...(options.databaseId === undefined ? {} : { databaseId: options.databaseId }),
    ...(emulatorCredentials === undefined
      ? {}
      : {
          credentials: {
            client_email: 'firestore-emulator@example.test',
            private_key: emulatorCredentials,
          },
        }),
  });
}
