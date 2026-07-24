/** Skill `paseo question wait` default window; Approvals TTL matches. */
export const INBOX_QUESTION_TTL_MS = 30 * 60 * 1000;

/** How long dismissed/expired rows stay on disk before hard-delete. */
export const INBOX_QUESTION_CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function inboxQuestionExpiresAt(fromMs: number = Date.now()): string {
  return new Date(fromMs + INBOX_QUESTION_TTL_MS).toISOString();
}

export function isInboxQuestionPastExpiry(
  question: { status: string; expiresAt?: string },
  nowMs: number = Date.now(),
): boolean {
  if (question.status !== "pending" || !question.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(question.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

export function isInboxQuestionClosedPastRetention(
  question: { status: string; closedAt?: string; createdAt: string },
  nowMs: number = Date.now(),
  retentionMs: number = INBOX_QUESTION_CLOSED_RETENTION_MS,
): boolean {
  if (question.status !== "dismissed" && question.status !== "expired") {
    return false;
  }
  const closedAtMs = Date.parse(question.closedAt ?? question.createdAt);
  return Number.isFinite(closedAtMs) && closedAtMs + retentionMs <= nowMs;
}
