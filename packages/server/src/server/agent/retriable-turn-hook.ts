// Minimal hook for provider turns that die with retriable transport/quota
// errors (e.g. Cursor ACP `RetriableError: [resource_exhausted]`). AgentManager
// schedules a continue turn with exponential backoff instead of treating the
// failure as terminal on the first hit.

export const RETRIABLE_TURN_MAX_ATTEMPTS = 10;
const RETRIABLE_TURN_BASE_DELAY_MS = 2_000;
const RETRIABLE_TURN_MAX_DELAY_MS = 60_000;

const RETRIABLE_ERROR_PATTERN =
  /RetriableError|resource_exhausted|rate_limit(?:_exceeded)?|overloaded|temporarily unavailable|\bunavailable\b|PING timed out|keepalive ping timed out|ConnectError|try again later/i;

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

const RETRIABLE_CONTINUE_USER_PROMPT_MAX_CHARS = 2_000;

/** Clip user text embedded in the continue nudge (keep enough to recover intent). */
export function clipRetriableContinueUserPrompt(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= RETRIABLE_CONTINUE_USER_PROMPT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, RETRIABLE_CONTINUE_USER_PROMPT_MAX_CHARS - 1)}…`;
}

export function formatRetriableContinuePrompt(args: {
  error: string;
  attempt: number;
  /** Latest real user message for the failed turn — keeps retry on that request. */
  lastUserPrompt?: string | null;
}): string {
  const clippedError = args.error.trim().replace(/\s+/g, " ").slice(0, 240);
  const clippedUser =
    typeof args.lastUserPrompt === "string" && args.lastUserPrompt.trim().length > 0
      ? clipRetriableContinueUserPrompt(args.lastUserPrompt)
      : null;
  return [
    "Previous turn failed with a retriable provider error.",
    `Attempt ${args.attempt}/${RETRIABLE_TURN_MAX_ATTEMPTS}.`,
    clippedError.length > 0 ? `Error: ${clippedError}` : null,
    clippedUser
      ? `Latest user message to continue:\n"""\n${clippedUser}\n"""\nResume that same user request from where you left off. Do not switch to an earlier task. Do not restart from scratch.`
      : "Continue the same task from where you left off. Do not restart from scratch.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
