/**
 * Strip quoted/fenced content and extract the closing segment used by the
 * prose-stop regex gate. Ported from check-prose-stop.sh (sciforum discipline).
 */

/** Remove fenced code, inline code, paired quotes, and blockquote lines. */
export function stripQuotedContent(text: string): string {
  const withoutFences = text
    .split("\n")
    .reduce<{ lines: string[]; inFence: boolean }>(
      (acc, line) => {
        if (/^\s*```/.test(line)) {
          return { lines: acc.lines, inFence: !acc.inFence };
        }
        if (!acc.inFence) {
          acc.lines.push(line);
        }
        return acc;
      },
      { lines: [], inFence: false },
    )
    .lines.join("\n");

  const withoutInline = withoutFences.replace(/`[^`]*`/g, "");
  const withoutQuotes = withoutInline
    .replace(/“[^”]*”/g, "")
    .replace(/‘[^’]*’/g, "")
    .replace(/「[^」]*」/g, "")
    .replace(/『[^』]*』/g, "")
    .replace(/"[^"]*"/g, "");

  return withoutQuotes
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

function isStructuredParagraph(paragraph: string): boolean {
  const lines = paragraph.split("\n");
  for (const line of lines) {
    if (!/^\s*(\||[-*+]\s|[0-9]+[.)]\s)/.test(line)) {
      return false;
    }
  }
  return true;
}

/**
 * Closing = last non-empty paragraph; if that paragraph is pure table/list,
 * widen back to last prose paragraph + everything after. All-structured
 * messages scan only the final paragraph. Trailing prose without `?` after a
 * prior ask widens one paragraph back.
 */
export function extractClosingSegment(text: string): string {
  const paragraphs: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (buf !== "") {
        paragraphs.push(buf);
        buf = "";
      }
      continue;
    }
    buf = buf === "" ? line : `${buf}\n${line}`;
  }
  if (buf !== "") {
    paragraphs.push(buf);
  }
  if (paragraphs.length === 0) {
    return "";
  }

  let i = paragraphs.length - 1;
  while (i > 0 && isStructuredParagraph(paragraphs[i]!)) {
    i -= 1;
  }

  if (isStructuredParagraph(paragraphs[i]!)) {
    i = paragraphs.length - 1;
  } else if (i > 0 && !/[?？]/.test(paragraphs[i]!) && /[?？]/.test(paragraphs[i - 1]!)) {
    i -= 1;
  }

  return paragraphs.slice(i).join("\n");
}

export function prepareClosingText(rawAssistantText: string): string {
  const stripped = stripQuotedContent(rawAssistantText);
  if (!stripped) {
    return "";
  }
  return extractClosingSegment(stripped);
}
