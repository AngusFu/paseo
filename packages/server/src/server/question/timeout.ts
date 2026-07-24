/**
 * Classify ask_question / MCP failures for the skill fallback ladder.
 * User dismiss must never match — that returns structured dismissed=true.
 */

const TIMEOUT_CODE_PATTERN = /(?:^|\D)(-32001)(?:\D|$)/;
const TIMEOUT_MESSAGE_PATTERNS = [
  /\btimed?\s*out\b/i,
  /\btimeout\b/i,
  /\bdeadline exceeded\b/i,
  /\bMCP error\b/i,
  /\btool (?:call )?unavailable\b/i,
  /\bunavailable\b/i,
  /\bConnectError\b/i,
  /\btransport (?:error|closed|aborted)\b/i,
  /\bASK_QUESTION_TIMEOUT\b/,
];

export function isAskQuestionTimeoutFailure(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  if (typeof error === "string") {
    return matchesTimeoutText(error);
  }
  if (typeof error !== "object") {
    return false;
  }
  const record = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    data?: unknown;
  };
  if (record.code === -32001 || record.code === "ASK_QUESTION_TIMEOUT") {
    return true;
  }
  if (typeof record.code === "string" && matchesTimeoutText(record.code)) {
    return true;
  }
  if (typeof record.message === "string" && matchesTimeoutText(record.message)) {
    return true;
  }
  if (typeof record.name === "string" && matchesTimeoutText(record.name)) {
    return true;
  }
  if (record.data && typeof record.data === "object") {
    const data = record.data as { code?: unknown; message?: unknown };
    if (data.code === -32001) {
      return true;
    }
    if (typeof data.message === "string" && matchesTimeoutText(data.message)) {
      return true;
    }
  }
  return matchesTimeoutText(String(error));
}

function matchesTimeoutText(text: string): boolean {
  if (TIMEOUT_CODE_PATTERN.test(text)) {
    return true;
  }
  return TIMEOUT_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}
