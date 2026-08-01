/**
 * Keep `paseo kb <ls|cat|grep> …` argv as close as possible to GNU coreutils /
 * grep so PreToolUse can rewrite with a simple prefix:
 *
 *   cat /paseo-vfs/docs/foo.md  →  paseo kb cat /paseo-vfs/docs/foo.md
 *   grep -ri pat /paseo-vfs/docs →  paseo kb grep -ri pat /paseo-vfs/docs
 */

export interface ParsedGrepArgs {
  pattern: string;
  paths: string[];
  ignoreCase: boolean;
  lineNumber: boolean;
  recursive: boolean;
  fixedStrings: boolean;
}

/** Parse grep-like argv after the subcommand name (pattern + files + short flags). */
export function parseGrepArgv(argv: string[]): ParsedGrepArgs {
  let ignoreCase = false;
  let lineNumber = false;
  let recursive = false;
  let fixedStrings = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-" && !arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        if (ch === "i") ignoreCase = true;
        else if (ch === "n") lineNumber = true;
        else if (ch === "r" || ch === "R") recursive = true;
        else if (ch === "F") fixedStrings = true;
        else if (ch === "E") {
          // JS RegExp is already "extended"; accept and ignore.
        } else {
          throw new Error(`paseo kb grep: unsupported option -${ch}`);
        }
      }
      continue;
    }
    if (arg === "--ignore-case") {
      ignoreCase = true;
      continue;
    }
    if (arg === "--line-number") {
      lineNumber = true;
      continue;
    }
    if (arg === "--recursive" || arg === "--dereference-recursive") {
      recursive = true;
      continue;
    }
    if (arg === "--fixed-strings") {
      fixedStrings = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`paseo kb grep: unsupported option ${arg}`);
    }
    positionals.push(arg);
  }

  const pattern = positionals[0];
  if (!pattern) {
    throw new Error("paseo kb grep: missing PATTERN");
  }
  return {
    pattern,
    paths: positionals.slice(1),
    ignoreCase,
    lineNumber,
    recursive,
    fixedStrings,
  };
}

export function escapeFixedString(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
