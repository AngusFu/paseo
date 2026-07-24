// Minimal hook for provider turns that die with retriable transport/quota
// errors (e.g. Cursor ACP `RetriableError: [resource_exhausted]`). AgentManager
// schedules a continue turn with exponential backoff instead of treating the
// failure as terminal on the first hit.

export const RETRIABLE_TURN_MAX_ATTEMPTS = 10;
const RETRIABLE_TURN_BASE_DELAY_MS = 2_000;
const RETRIABLE_TURN_MAX_DELAY_MS = 60_000;

const RETRIABLE_ERROR_PATTERN =
  /RetriableError|resource_exhausted|rate_limit(?:_exceeded)?|overloaded|temporarily unavailable|try again later/i;

export function isRetriableProviderError(message: string): boolean {
  return RETRIABLE_ERROR_PATTERN.test(message);
}

/** Attempt is 1-based (first retry after the original failure = 1). */
export function retriableTurnBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const delay = RETRIABLE_TURN_BASE_DELAY_MS * 2 ** (safeAttempt - 1);
  return Math.min(RETRIABLE_TURN_MAX_DELAY_MS, delay);
}

export function shouldRetryRetriableTurn(args: { error: string; attemptCount: number }): boolean {
  if (args.attemptCount >= RETRIABLE_TURN_MAX_ATTEMPTS) {
    return false;
  }
  return isRetriableProviderError(args.error);
}

export function formatRetriableContinuePrompt(args: { error: string; attempt: number }): string {
  const clipped = args.error.trim().replace(/\s+/g, " ").slice(0, 240);
  return [
    "Previous turn failed with a retriable provider error.",
    `Attempt ${args.attempt}/${RETRIABLE_TURN_MAX_ATTEMPTS}.`,
    clipped.length > 0 ? `Error: ${clipped}` : null,
    "Continue the same task from where you left off. Do not restart from scratch.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}
