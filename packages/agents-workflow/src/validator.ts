/**
 * §11 static script validator — the BELT behind the vm sandbox.
 *
 * `validateScript(source)` scans an AGENT-AUTHORED workflow script for
 * dangerous patterns BEFORE it ever runs. It is a defense-in-depth belt, NOT
 * a proof: a determined author can obfuscate (see "HONEST LIMITS" below), and
 * the REAL containment is the node:vm realm (codegen off, no host handle
 * reachable — see sandbox.ts). This layer catches the obvious host-escape /
 * reflection / node-surface / prototype-pollution shapes cheaply and up front
 * so a bad script is rejected before load, not merely contained at runtime.
 *
 * CRITICAL — scan CODE ONLY, not string/template/comment CONTENT.
 * The 10 built-in workflow scripts' PROMPTS legitimately say "require",
 * "process", "fetch", "module", "constructor" etc. in PROSE. A naive regex
 * over the raw source would flag all of them. So we run a light lexer
 * (maskNonCode) that blanks the CONTENT of:
 *   - '...' and "..." string literals
 *   - `...` template literals (but code inside `${ ... }` IS still scanned)
 *   - // line comments and (slash-star) block comments
 *   - /.../ regex literals (best-effort division-vs-regex heuristic)
 * ...replacing each with spaces (length + newlines preserved so a match index
 * still points at the real source). The banned-pattern regexes then run over
 * the MASKED text, so they only fire in actual CODE positions.
 *
 * HONEST LIMITS (why this is a belt, not a proof):
 *   - String-concat obfuscation is INVISIBLE post-mask: `x["con"+"structor"]`
 *     and `globalThis["pro"+"cess"]` split the payload across two masked
 *     strings, so the words never appear in code. The vm sandbox blocks these
 *     at runtime (codegen off) — that is the real belt. sandbox.test.ts proves
 *     `agent["constr"+"uctor"]...` throws.
 *   - The division-vs-regex call is a heuristic (a bare `/` after an operator
 *     is treated as a regex start). A genuine `a / process / b` division chain
 *     is scanned as code (good), but a misjudged division could mask a token
 *     between two slashes (rare; a false-NEGATIVE, never a false-positive that
 *     would break a builtin).
 *   - Module-specifier STRINGS (`require("fs")`, `import "node:fs"`) are
 *     masked, so the specifier itself is not read — the require(/import(/
 *     node: mechanism rules reject those calls regardless of the specifier.
 */

// one reported hit: which rule, where in the source, and the code that tripped.
export interface Violation {
  rule: string;
  index: number;
  snippet: string;
}

export interface ValidateResult {
  ok: boolean;
  violations: Violation[];
}

// ── the light lexer: blank out non-code content, keep code intact ──
// returns a same-length copy of `src` where every string/template/comment/
// regex CONTENT char is a space (newlines kept). Code inside `${ }` stays code.
function maskNonCode(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = src[k];
  // blank one char (keep newlines so index math + snippets stay honest).
  const blank = (k: number): void => {
    if (out[k] !== "\n") out[k] = " ";
  };

  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex";
  let mode: Mode = "code";
  let regexInClass = false; // inside a [...] char-class a `/` does not close
  const interp: number[] = []; // brace depth per active `${ ... }` (nestable)
  let prevSig = ""; // last significant CODE char (regex-vs-div oracle)
  let word = ""; // trailing identifier/keyword ending at prevSig

  const isWord = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
  // keywords after which a `/` begins a REGEX, not a division.
  const KW = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "do",
    "else",
    "yield",
    "await",
    "case",
    "throw",
  ]);
  // is the `/` at the cursor a regex start (vs a division operator)?
  const regexOk = (): boolean => {
    if (prevSig === "") return true; // start of input
    if (isWord(prevSig)) return KW.has(word); // ident -> div; keyword -> regex
    if (prevSig === ")" || prevSig === "]" || prevSig === "}") return false; // expr end -> div
    if (prevSig === '"' || prevSig === "'" || prevSig === "`") return false; // string/regex end -> div
    return true; // operator / punctuation -> regex
  };
  // update the significant-token trackers for a KEPT code char.
  const bump = (ch: string): void => {
    if (/\s/.test(ch)) return;
    prevSig = ch;
    if (isWord(ch)) word += ch;
    else word = "";
  };
  // reset trackers to an "expression end" so a following `/` reads as division.
  const exprEnd = (ch: string): void => {
    prevSig = ch;
    word = "";
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        blank(i);
        blank(i + 1);
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        blank(i);
        blank(i + 1);
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        blank(i);
        mode = "sq";
        i++;
        continue;
      }
      if (c === '"') {
        blank(i);
        mode = "dq";
        i++;
        continue;
      }
      if (c === "`") {
        blank(i);
        mode = "tmpl";
        i++;
        continue;
      }
      if (c === "/" && regexOk()) {
        blank(i);
        mode = "regex";
        regexInClass = false;
        i++;
        continue;
      }
      // `${ ... }` brace tracking: a `}` at depth 0 closes the interpolation.
      if (interp.length) {
        if (c === "{") {
          interp[interp.length - 1]++;
        } else if (c === "}") {
          if (interp[interp.length - 1] === 0) {
            interp.pop();
            blank(i);
            mode = "tmpl";
            exprEnd("}");
            i++;
            continue;
          }
          interp[interp.length - 1]--;
        }
      }
      bump(c);
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        blank(i);
        blank(i + 1);
        mode = "code";
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      const q = mode === "sq" ? "'" : '"';
      if (c === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (c === q) {
        blank(i);
        mode = "code";
        exprEnd('"');
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (mode === "tmpl") {
      if (c === "\\") {
        blank(i);
        if (i + 1 < n) blank(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i);
        mode = "code";
        exprEnd("`");
        i++;
        continue;
      }
      if (c === "$" && c2 === "{") {
        blank(i);
        blank(i + 1);
        interp.push(0);
        mode = "code";
        exprEnd("(");
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    // mode === "regex"
    if (c === "\\") {
      blank(i);
      if (i + 1 < n) blank(i + 1);
      i += 2;
      continue;
    }
    if (c === "[") {
      regexInClass = true;
      blank(i);
      i++;
      continue;
    }
    if (c === "]") {
      regexInClass = false;
      blank(i);
      i++;
      continue;
    }
    if (c === "/" && !regexInClass) {
      blank(i);
      mode = "code";
      exprEnd(")");
      i++;
      while (i < n && /[a-z]/i.test(src[i])) {
        blank(i);
        i++;
      } // eat + blank flags
      continue;
    }
    blank(i);
    i++;
  }
  return out.join("");
}

// ── the banned-pattern rule table ──
// `raw:true` rules scan the ORIGINAL source (not the masked copy) because the
// payload lives INSIDE a string literal that masking would hide (a computed
// `["constructor"]`, a `__proto__` key access, a `"node:..."` specifier). Those
// three literal shapes are specific enough that no builtin PROSE contains them.
interface Rule {
  rule: string;
  re: RegExp;
  raw?: boolean;
}
const RULES: Rule[] = [
  // host escapes (bare code identifiers)
  { rule: "process", re: /\bprocess\b/g },
  { rule: "require", re: /\brequire\b/g },
  { rule: "module", re: /\bmodule\b/g },
  { rule: "globalThis", re: /\bglobalThis\b/g },
  { rule: "global", re: /\bglobal\b/g },
  { rule: "Buffer", re: /\bBuffer\b/g },
  // code-gen / reflection
  { rule: "eval", re: /\beval\s*\(/g },
  { rule: "function-ctor", re: /\bnew\s+Function\b|\bFunction\s*\(/g },
  { rule: "constructor", re: /\.constructor\b/g },
  { rule: "import", re: /\bimport\b/g },
  // Fix K — a `\u` unicode escape in an IDENTIFIER (`x.constructor`,
  // `process`) reads as `x.constructor` / `process` at parse time but slips
  // PAST the literal-text rules above. Workflow CODE has no legit reason to
  // unicode-escape an identifier, so flag ANY `\u` surviving in a CODE position
  // (string/template/comment/regex escapes are already masked to spaces, so a
  // `\u` inside a STRING stays hidden and does not trip this).
  { rule: "unicode-escape", re: /\\u/g },
  // node surface
  { rule: "child_process", re: /\bchild_process\b/g },
  { rule: "node-module", re: /\b(?:fs|net|http|https)\s*\./g },
  { rule: "fetch", re: /\bfetch\s*\(/g },
  // prototype pollution (dot-access `.prototype[` form; code position)
  { rule: "prototype-index", re: /\.prototype\s*\[/g },
  // RAW-source rules (payload is a string literal masking would hide)
  { rule: "computed-constructor", re: /\[\s*(["'`])constructor\1\s*\]/g, raw: true },
  { rule: "proto-pollution", re: /__proto__/g, raw: true },
  { rule: "node-specifier", re: /(["'`])node:/g, raw: true },
];

/**
 * Scan an authored workflow SOURCE for dangerous patterns.
 * `ok:false` + a list of {rule,index,snippet} when any banned shape is found
 * in a CODE position (or, for the raw rules, as a literal string payload).
 */
export function validateScript(source: string): ValidateResult {
  const masked = maskNonCode(source);
  const violations: Violation[] = [];
  for (const { rule, re, raw } of RULES) {
    const hay = raw ? source : masked;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hay)) !== null) {
      const index = m.index;
      // snippet from the ORIGINAL source (a code-position match is unchanged
      // by masking, so masked.slice === source.slice there).
      violations.push({ rule, index, snippet: source.slice(index, index + m[0].length) });
      if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width loops
    }
  }
  violations.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
  return { ok: violations.length === 0, violations };
}
