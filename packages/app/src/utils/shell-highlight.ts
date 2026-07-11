// Lightweight shell-command tokenizer for inline syntax highlighting.
//
// The shared @getpaseo/highlight package has no shell grammar, so this does a
// small, dependency-free pass good enough to color a command line the way an
// editor would: the command name, flags, quoted strings, paths, and operators.
// It is deliberately not a full shell parser — it never executes anything and
// only needs to be visually reasonable, not semantically exact.

export type ShellTokenStyle = "command" | "flag" | "string" | "operator" | "path" | "plain";

export interface ShellToken {
  text: string;
  style: ShellTokenStyle;
}

// Sequences that separate commands (the next word is a fresh command name) and
// plain redirections. Ordered longest-first so `&&` wins over `&`, `>>` over `>`.
const COMMAND_SEPARATORS = ["&&", "||", "|", ";", "&"];
const REDIRECTIONS = [">>", ">", "<"];
const OPERATORS = [...COMMAND_SEPARATORS, ...REDIRECTIONS];
const BOUNDARY_CHARS = new Set([" ", "\t", "\n", '"', "'", "&", "|", ";", ">", "<"]);

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n";
}

function matchOperator(input: string, index: number): string | null {
  for (const candidate of OPERATORS) {
    if (input.startsWith(candidate, index)) {
      return candidate;
    }
  }
  return null;
}

// Consume a whitespace run starting at `index`; returns its end index.
function scanWhitespace(input: string, index: number): number {
  let j = index + 1;
  while (j < input.length && isWhitespace(input[j])) {
    j++;
  }
  return j;
}

// Consume a quoted string starting at the opening quote; returns its end index
// (past the closing quote). Backslash escapes are honored inside double quotes.
function scanQuoted(input: string, index: number, quote: string): number {
  let j = index + 1;
  while (j < input.length) {
    if (input[j] === "\\" && quote === '"') {
      j += 2;
      continue;
    }
    if (input[j] === quote) {
      return j + 1;
    }
    j++;
  }
  return j;
}

// Consume a bare word (up to the next boundary char); returns its end index.
function scanWord(input: string, index: number): number {
  let j = index;
  while (j < input.length && !BOUNDARY_CHARS.has(input[j])) {
    j++;
  }
  return j;
}

function classifyWord(word: string, atCommandStart: boolean): ShellTokenStyle {
  if (atCommandStart) return "command";
  if (word.startsWith("-")) return "flag";
  if (word.includes("/")) return "path";
  return "plain";
}

/**
 * Split a shell command string into styled tokens. Whitespace is preserved as
 * `plain` tokens so the caller can render the segments back to back without
 * losing spacing.
 */
export function tokenizeShellCommand(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  // The next non-whitespace word is a command name (start of string or right
  // after a command separator like `&&`, `|`, `;`).
  let atCommandStart = true;

  while (i < input.length) {
    const char = input[i];

    if (isWhitespace(char)) {
      const end = scanWhitespace(input, i);
      const text = input.slice(i, end);
      // A newline behaves like a command separator for the next word.
      if (text.includes("\n")) atCommandStart = true;
      tokens.push({ text, style: "plain" });
      i = end;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = scanQuoted(input, i, char);
      tokens.push({ text: input.slice(i, end), style: "string" });
      atCommandStart = false;
      i = end;
      continue;
    }

    const operator = matchOperator(input, i);
    if (operator) {
      tokens.push({ text: operator, style: "operator" });
      if (COMMAND_SEPARATORS.includes(operator)) atCommandStart = true;
      i += operator.length;
      continue;
    }

    const end = scanWord(input, i);
    const word = input.slice(i, end);
    tokens.push({ text: word, style: classifyWord(word, atCommandStart) });
    atCommandStart = false;
    i = end;
  }

  return tokens;
}
