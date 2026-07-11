// Splits a user's message into styled segments for rich rendering: a leading
// slash-command (e.g. "/bug-ticket-fix"), URLs, and plain text. Display-only —
// this never runs the command or fetches the URL.

export type UserMessageSegmentKind = "command" | "url" | "plain";

export interface UserMessageSegment {
  text: string;
  kind: UserMessageSegmentKind;
  // For url segments, the trimmed href (without trailing punctuation).
  href?: string;
}

const LEADING_COMMAND = /^\/[A-Za-z0-9][A-Za-z0-9_-]*/;
const URL_PATTERN = /https?:\/\/[^\s]+/g;
// Punctuation that commonly trails a URL in prose but is not part of it.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

// Split a run of plain text into url + plain segments.
function splitUrls(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const trailing = TRAILING_PUNCTUATION.exec(raw)?.[0] ?? "";
    const href = raw.slice(0, raw.length - trailing.length);
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), kind: "plain" });
    }
    segments.push({ text: href, kind: "url", href });
    if (trailing) {
      segments.push({ text: trailing, kind: "plain" });
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), kind: "plain" });
  }
  return segments;
}

/**
 * Tokenize a user message into styled segments. Segments concatenate back to
 * the original string exactly (lossless).
 */
export function segmentUserMessage(message: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  let rest = message;

  const commandMatch = LEADING_COMMAND.exec(message);
  if (commandMatch) {
    segments.push({ text: commandMatch[0], kind: "command" });
    rest = message.slice(commandMatch[0].length);
  }

  segments.push(...splitUrls(rest));
  return segments;
}
