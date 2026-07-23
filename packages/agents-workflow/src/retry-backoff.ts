/**
 * How long to wait before retrying an agent call.
 *
 * Retries used to fire back-to-back: three attempts inside 7ms, all landing on
 * the same cached provider state. Nothing that fails can recover in that
 * window, so the attempts cost tokens and told the reader a transient fault had
 * been ruled out when nothing had been tried twice.
 *
 * A backend error (the agent never ran — provider unavailable, create failed)
 * waits long enough for the condition to actually clear. A malformed-output
 * retry does not wait at all: the model is being asked to answer again, and the
 * only thing that changes is the prompt.
 */

export const BACKEND_ERROR_RETRY_BASE_MS = 2_000;
export const BACKEND_ERROR_RETRY_MAX_MS = 30_000;

export type RetryReason = "backend-error" | "bad-output";

/**
 * Delay before attempt `attempt + 1`, where `attempt` is the 0-based index of
 * the attempt that just failed. Backend errors double each time, capped so a
 * long retry chain cannot stall a workflow indefinitely.
 */
export function retryDelayMs(reason: RetryReason, attempt: number): number {
  if (reason !== "backend-error") {
    return 0;
  }
  const doubled = BACKEND_ERROR_RETRY_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(doubled, BACKEND_ERROR_RETRY_MAX_MS);
}
