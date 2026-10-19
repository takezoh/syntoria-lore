const timeoutMs = 60_000;
const end = Date.now() + timeoutMs;
const checks = ['http://localhost:18080/readyz'];
let lastFailure = 'not ready';
while (Date.now() < end) {
  try {
    for (const url of checks) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`${new URL(url).port} returned HTTP ${response.status}`);
    }
    process.stdout.write('API database/ledger gate and private worker are ready.\n');
    process.exit(0);
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : 'not ready';
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
process.stderr.write(`Local services did not become ready: ${lastFailure}\n`);
process.exit(1);
