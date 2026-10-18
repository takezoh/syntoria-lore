import { randomBytes } from 'node:crypto';
import { chmod, open, readFile } from 'node:fs/promises';

const path = new URL('../.env.local', import.meta.url);
try {
  const existing = await readFile(path, 'utf8');
  if (!existing.includes('LOCAL_DB_PASSWORD=') || !existing.includes('WORKER_TASK_TOKEN=')) {
    throw new Error('Existing .env.local is incomplete; move it aside before regenerating.');
  }
  await chmod(path, 0o600);
  process.stdout.write('Local-only secret file already exists.\n');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  const lines = [
    `LOCAL_DB_PASSWORD=${secret(36)}`,
    `APP_DB_PASSWORD=${secret(36)}`,
    `WORKER_DB_PASSWORD=${secret(36)}`,
    `WORKER_TASK_TOKEN=${secret(48)}`,
    `FORGET_HMAC_KEY=${secret(48)}`,
    `PORTABILITY_MASTER_KEY=${secret(48)}`,
    `CURSOR_HMAC_KEY=${secret(48)}`,
    `LOCAL_CONTROL_TOKEN=${secret(36)}`,
  ];
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${lines.join('\n')}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  process.stdout.write('Created ignored local-only secrets; no host credentials were read.\n');
}

function secret(bytes) {
  return randomBytes(bytes).toString('base64url');
}
