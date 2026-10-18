export async function verifyDuplicateWorkerSweeps({
  workerUrl,
  workerIdToken,
  timeoutMs,
  expectedCaptureStatus,
  readCaptureStatus,
  fetchImpl = fetch,
}) {
  if (
    !['committed', 'held'].includes(expectedCaptureStatus) ||
    typeof workerIdToken !== 'string' ||
    workerIdToken.length < 32 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    typeof readCaptureStatus !== 'function'
  ) {
    throw new Error('Worker sweep verification configuration is invalid');
  }

  const sweeps = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    const response = await fetchImpl(new URL('/internal/dispatch/sweep', workerUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerIdToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const metrics = requireCompletedSweepResponse(response.status, body);
    const captureStatus = await readCaptureStatus();
    if (captureStatus !== expectedCaptureStatus) {
      throw new Error('Completed worker sweep changed the terminal capture state');
    }
    sweeps.push({
      attempt,
      worker_status: response.status,
      elapsed_ms: Date.now() - startedAt,
      metrics,
      capture_status: captureStatus,
    });
  }
  return sweeps;
}

function requireCompletedSweepResponse(status, body) {
  if (status !== 200) throw new Error(`Authenticated worker sweep returned HTTP ${status}`);
  if (
    !isRecord(body) ||
    !isRecord(body.outbox) ||
    !isCount(body.outbox.dispatched) ||
    !isCount(body.outbox.retrying) ||
    !isCount(body.due_jobs) ||
    !isCountRecord(body.governance) ||
    !isCountRecord(body.portability)
  ) {
    throw new Error('Authenticated worker sweep omitted its completed sweep metrics');
  }
  return {
    outbox: { dispatched: body.outbox.dispatched, retrying: body.outbox.retrying },
    due_jobs: body.due_jobs,
    governance: body.governance,
    portability: body.portability,
  };
}

function isCountRecord(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((count) => isCount(count))
  );
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
