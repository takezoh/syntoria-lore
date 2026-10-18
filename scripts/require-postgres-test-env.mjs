import process from 'node:process';

const required = ['TEST_ADMIN_URL', 'TEST_APP_URL'];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  process.stderr.write(`PostgreSQL integration tests require: ${missing.join(', ')}\n`);
  process.exitCode = 1;
}
