/**
 * When a provider that failed to load is worth probing again.
 *
 * A provider probe can fail for reasons that pass on their own — the agent CLI
 * was still starting up, a socket was not listening yet. The snapshot only
 * re-probes entries left in `loading`, so without this an entry that failed
 * once stayed failed for the life of the daemon: every later request was
 * answered from the cached failure without the provider ever being asked again.
 *
 * A short cooldown keeps a genuinely broken provider from being probed on every
 * request while letting a transient failure heal by itself.
 */

/** Long enough that a broken provider is not re-probed per request. */
export const PROVIDER_ERROR_RETRY_COOLDOWN_MS = 30_000;

interface RetryableEntry {
  status: string;
  /** ISO timestamp of the probe that produced this entry. */
  fetchedAt?: string;
}

export function shouldRetryProviderError(
  entry: RetryableEntry | undefined,
  now: number,
  cooldownMs: number = PROVIDER_ERROR_RETRY_COOLDOWN_MS,
): boolean {
  if (entry?.status !== "error") {
    return false;
  }
  if (!entry.fetchedAt) {
    // Written by a version that did not stamp failures, or a clock we cannot
    // read. Retrying once beats staying wrong until the daemon restarts.
    return true;
  }
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetchedAt)) {
    return true;
  }
  // `now < fetchedAt` means the clock moved backwards; treat the entry as fresh
  // rather than re-probing on every request until wall time catches up.
  return now - fetchedAt >= cooldownMs;
}
