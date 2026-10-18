const outboxLimit = 50;
const dueJobLimit = 100;

export interface DispatchSweepDependencies {
  readonly dispatchPending: (limit: number) => Promise<{ dispatched: number; retrying: number }>;
  readonly sweepDueJobs: (limit: number) => Promise<number>;
  readonly runGovernanceSweep: () => Promise<Readonly<Record<string, number>>>;
  readonly runPortabilitySweep: () => Promise<Readonly<Record<string, number>>>;
}

export function createDispatchSweep(dependencies: DispatchSweepDependencies): () => Promise<{
  outbox: { dispatched: number; retrying: number };
  due_jobs: number;
  governance: Readonly<Record<string, number>>;
  portability: Readonly<Record<string, number>>;
}> {
  return async () => {
    const outbox = await dependencies.dispatchPending(outboxLimit);
    const dueJobs = await dependencies.sweepDueJobs(dueJobLimit);
    const firstGovernance = await dependencies.runGovernanceSweep();
    const portability = await dependencies.runPortabilitySweep();
    const secondGovernance = await dependencies.runGovernanceSweep();
    const governance = mergeGovernancePasses(firstGovernance, secondGovernance);
    return { outbox, due_jobs: dueJobs, governance, portability };
  };
}

function mergeGovernancePasses(
  first: Readonly<Record<string, number>>,
  second: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const finalPassMetrics = new Set(['pending', 'retention_pending', 'indexing_pending']);
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      finalPassMetrics.has(key)
        ? (second[key] ?? first[key] ?? 0)
        : (first[key] ?? 0) + (second[key] ?? 0),
    ]),
  );
}
