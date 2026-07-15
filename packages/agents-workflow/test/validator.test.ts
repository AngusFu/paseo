// §11 static validator — PROVE each banned pattern is flagged in a CODE
// position, NOT flagged inside a string/template/comment (the false-positive
// guard), and that ALL 10 built-in workflows pass (ok:true). The false-
// positive guard is the whole point: builtin PROMPTS say "process"/"require"/
// "fetch" in prose, and a naive regex would wrongly reject them.
import { test, expect } from "vitest";
import { validateScript } from "../src/validator.js";
import { listWorkflows } from "../src/registry.js";

// helper: does the result carry a violation of the given rule?
const has = (src: string, rule: string): boolean =>
  validateScript(src).violations.some((v) => v.rule === rule);

// ── each banned pattern: flagged in CODE, clean in a string ──
// [rule, code-that-trips-it, benign-string-that-must-NOT-trip-it]
const CASES: Array<[string, string, string]> = [
  ["process", "const p = process.env.HOME;", '"read the process list"'],
  ["require", "const x = require;", '"you require a token"'],
  ["module", "const m = module.exports;", '"a module of code"'],
  ["globalThis", "const g = globalThis.x;", '"globalThis is a global"'],
  ["global", "global.leak = 1;", '"a global variable"'],
  ["Buffer", "const b = Buffer.alloc(8);", '"a ring Buffer"'],
  ["eval", 'eval("1+1");', '"do not eval user input"'],
  ["function-ctor", 'const f = new Function("return 1");', '"use new Function to eval"'],
  ["constructor", "const c = x.constructor;", '"call the constructor"'],
  ["import", 'import fs from "fs";', '"important context follows"'],
  ["child_process", "const cp = child_process.exec;", '"spawn a child_process"'],
  ["node-module", "const d = fs.readFileSync('/etc/hostname');", '"the fs module is handy"'],
  ["fetch", 'fetch("https://evil.com");', '"fetch the sources first"'],
  ["prototype-index", "Array.prototype[0] = 1;", '"the prototype pattern"'],
];

for (const [rule, code, str] of CASES) {
  test(`rule "${rule}" fires in CODE`, () => {
    expect(has(code, rule)).toBe(true);
    expect(validateScript(code).ok).toBe(false);
  });
  test(`rule "${rule}" does NOT fire inside a string`, () => {
    // a bare string expression is legit code whose CONTENT must be ignored.
    expect(has(`const s = ${str};`, rule)).toBe(false);
  });
}

// ── the three RAW-source rules (payload lives inside a string literal) ──
test("computed-constructor: x['constructor'] is flagged", () => {
  expect(has(`const c = x["constructor"];`, "computed-constructor")).toBe(true);
  expect(has(`const c = x['constructor'];`, "computed-constructor")).toBe(true);
});
test("proto-pollution: __proto__ dot AND bracket both flagged", () => {
  expect(has("obj.__proto__ = {};", "proto-pollution")).toBe(true);
  expect(has(`obj["__proto__"] = {};`, "proto-pollution")).toBe(true);
});
test("node-specifier: a 'node:' module specifier string is flagged", () => {
  expect(has(`import x from "node:fs";`, "node-specifier")).toBe(true);
  expect(has(`const m = require("node:child_process");`, "node-specifier")).toBe(true);
});

// ── Fix K (LOW) — a `\u` unicode escape in an IDENTIFIER (`x.constructor`,
// `process`) parses as `x.constructor` / `process` but slipped past the
// literal-text rules. Flag ANY `\u` in a CODE position; a `\u` inside a STRING
// is still masked (not flagged).
test("Fix K: a unicode-escaped identifier in CODE is flagged", () => {
  expect(has(`const c = x.\\u0063onstructor;`, "unicode-escape")).toBe(true);
  expect(has(`\\u0070rocess.env.HOME;`, "unicode-escape")).toBe(true);
});
test("Fix K: a \\u inside a STRING literal is NOT flagged (still masked)", () => {
  expect(has(`const s = "\\u2014 an em dash";`, "unicode-escape")).toBe(false);
  expect(validateScript(`const s = "\\u2014 an em dash";`).ok).toBe(true);
});

// ── the false-positive guard, exercised across skip contexts ──
test("banned words in a // line comment are NOT flagged", () => {
  const src = "// process require eval new Function child_process fetch(\nconst ok = 1;";
  expect(validateScript(src).ok).toBe(true);
});
test("banned words in a /* block */ comment are NOT flagged", () => {
  const src = "/* process require module globalThis Buffer eval( */\nconst ok = 1;";
  expect(validateScript(src).ok).toBe(true);
});
test("banned words in a template TEXT are NOT flagged", () => {
  const src = "const t = `first process the require then fetch the module`;";
  expect(validateScript(src).ok).toBe(true);
});
test("code INSIDE a template ${...} IS scanned", () => {
  // the interpolation is real code — process must be caught here.
  const src = "const t = `value is ${process.env.HOME}`;";
  expect(has(src, "process")).toBe(true);
});
test("nested template ${ `x ${process} y` } still scans the inner code", () => {
  const src = "const t = `a ${`b ${process.pid} c`} d`;";
  expect(has(src, "process")).toBe(true);
});
test("a /regex/ literal's CONTENT is not scanned", () => {
  // /require|process/ is a harmless matcher, not host access.
  const src = "const re = /require|process|fetch/g;\nconst ok = 1;";
  expect(validateScript(src).ok).toBe(true);
});
test("division adjacent to a banned identifier still flags the identifier", () => {
  // `a / process / b` is division-division, NOT a regex — process is real code.
  expect(has("const z = a / process / b;", "process")).toBe(true);
});
test("`required` object key does NOT trip the require rule", () => {
  expect(has("const s = { required: ['a', 'b'] };", "require")).toBe(false);
});
test("lowercase `function` decl does NOT trip function-ctor", () => {
  expect(has("function helper(x) { return x + 1; }", "function-ctor")).toBe(false);
});
test("Object.prototype.hasOwnProperty (dot, no bracket) is NOT flagged", () => {
  expect(has("Object.prototype.hasOwnProperty.call(o, 'k');", "prototype-index")).toBe(false);
});

// ── shape of a clean vs dirty result ──
test("a fully benign script is ok:true with no violations", () => {
  const src = `export const meta = { name: "t" };\nconst r = await agent("do", { label: "L" });\nreturn r;`;
  const res = validateScript(src);
  expect(res.ok).toBe(true);
  expect(res.violations).toEqual([]);
});
test("multiple violations are sorted by index", () => {
  const src = "const a = require; const b = process; eval('x');";
  const res = validateScript(src);
  expect(res.ok).toBe(false);
  const idxs = res.violations.map((v) => v.index);
  expect(idxs).toEqual([...idxs].sort((x, y) => x - y));
  const rules = res.violations.map((v) => v.rule);
  expect(rules).toContain("require");
  expect(rules).toContain("process");
  expect(rules).toContain("eval");
});
test("a violation snippet quotes the real offending code", () => {
  const res = validateScript("const p = process;");
  const v = res.violations.find((x) => x.rule === "process")!;
  expect(v.snippet).toBe("process");
  expect(res.ok).toBe(false);
});

// ── HARD REQUIREMENT: every built-in workflow passes the validator ──
// if any trips, the LEXER is false-positiving on prose — fix the lexer, never
// weaken a real rule.
// builtin/ holds the 10 Anthropic .flow.js flows — ALL must pass, no carve-out.
test("ALL 10 built-in workflows pass validateScript (ok:true)", () => {
  const builtins = listWorkflows().filter((w) => w.origin === "builtin");
  expect(builtins.length).toBe(10);
  for (const wf of builtins) {
    const res = validateScript(wf.source);
    expect(res.ok, `builtin "${wf.name}" tripped: ${JSON.stringify(res.violations)}`).toBe(true);
  }
});

// document the known static-analysis LIMIT: string-concat obfuscation is
// invisible post-mask (the payload is split across two masked strings). the
// vm sandbox (codegen off) blocks these at RUNTIME — that is the real belt.
test("KNOWN LIMIT: string-concat obfuscation evades the static belt", () => {
  const src = `const c = x["con" + "structor"];`;
  // the lexer masks each string's content, so "constructor" never appears in
  // code — the validator cannot see it. sandbox.test.ts proves the vm blocks
  // the equivalent agent["constr"+"uctor"] at runtime.
  expect(validateScript(src).ok).toBe(true);
});
