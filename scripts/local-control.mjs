import { readFile } from 'node:fs/promises';

const command = process.argv[2];
const env = parse(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
const token = env.LOCAL_CONTROL_TOKEN;
if (!token) throw new Error('LOCAL_CONTROL_TOKEN is missing; run scripts/local.sh start');
const endpoints = {
  scheduler: ['http://localhost:19092/__fixture/trigger', 'POST'],
  'scheduler-duplicate': ['http://localhost:19092/__fixture/trigger?duplicate=true', 'POST'],
  'task-fail': ['http://localhost:19091/__fixture/fail-next', 'POST'],
  'provider-fail-curator': ['http://localhost:19091/__fixture/provider-fail-next/curator', 'POST'],
  'provider-fail-embedding': [
    'http://localhost:19091/__fixture/provider-fail-next/embedding',
    'POST',
  ],
};
const endpoint = endpoints[command];
if (!endpoint) throw new Error('Unknown local control action');
const response = await fetch(endpoint[0], {
  method: endpoint[1],
  headers: { 'x-local-control-token': token },
  signal: AbortSignal.timeout(35_000),
});
const body = await response.json();
if (!response.ok) throw new Error(`Local control fixture returned HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify(body)}\n`);

function parse(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
