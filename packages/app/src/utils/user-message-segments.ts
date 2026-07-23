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

// Includes ":" so plugin-namespaced commands like "/claude-hud:configure" are
// captured whole rather than stopping at the colon.
const LEADING_COMMAND = /^\/[A-Za-z0-9][A-Za-z0-9_:-]*/;
// A URL runs to the next character that cannot be in one. Stopping only at
// whitespace swallowed the prose after it whenever a link was followed
// immediately by CJK text — `https://example.com（注释）` linked the note too.
// The excluded ranges are CJK ideographs, kana, Hangul, CJK punctuation,
// full-width forms, and typographic quotes and dashes; a URL carrying any of
// those would be percent-encoded in practice.
const NOT_IN_URL =
  "\\s\\u2013\\u2014\\u2018-\\u201f\\u3000-\\u303f\\u3040-\\u30ff\\u4e00-\\u9fff\\uac00-\\ud7af\\uff00-\\uffef";
const URL_PATTERN = new RegExp(`https?://[^${NOT_IN_URL}]+`, "g");
// Punctuation that commonly trails a URL in prose but is not part of it. The
// full-width halves are here for the same reason as the ranges above: a link
// pasted into a Chinese sentence is usually followed by 。or ）.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"，。；：！？）】》」』、]+$/;

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
