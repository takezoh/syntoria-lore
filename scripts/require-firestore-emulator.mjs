const value = process.env['FIRESTORE_EMULATOR_HOST'];
if (!value) {
  console.error(
    'Firestore emulator is required: set FIRESTORE_EMULATOR_HOST to a loopback host and port.',
  );
  process.exit(1);
}

const match = /^(\[[0-9a-f:]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/u.exec(value);
const host = match?.[1]?.replace(/^\[|\]$/gu, '').toLowerCase();
const port = Number(match?.[2]);
const loopback = host === 'localhost' || host === '::1' || host?.startsWith('127.');
if (!loopback || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Firestore emulator is required at a loopback FIRESTORE_EMULATOR_HOST.');
  process.exit(1);
}
