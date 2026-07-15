/**
 * Concurrency helper. The limiter itself is p-limit now (Swap 2) — the engine
 * calls pLimit(n) directly. Only the default-sizing helper survives here.
 */

/** Pick a default concurrency from cpu count. */
export function defaultConcurrency(cpuCount: number): number {
  // Deliberately above Claude's min(16, cores-2): backends are real processes.
  return Math.min(32, Math.max(2, cpuCount * 2));
}
