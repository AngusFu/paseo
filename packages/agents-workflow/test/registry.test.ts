// registry resolves workflows by name or path. covers the builtin dir wiring
// (flow2 layout: workflows/ sibling of src/) that flowkit shipped untested.
import { test, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkflow, listWorkflows } from "../src/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINI = path.join(__dirname, "..", "workflows", "bughunt-lite-mini.flow.js");

test("listWorkflows discovers the 10 Anthropic builtins + project mini", () => {
  // Project origin is cwd-relative; pin cwd to this package so monorepo-root
  // vitest invocations still see workflows/bughunt-lite-mini.flow.js.
  const pkgRoot = path.join(__dirname, "..");
  const prevCwd = process.cwd();
  process.chdir(pkgRoot);
  try {
    const wfs = listWorkflows();
    const builtin = wfs.filter((w) => w.origin === "builtin");
    expect(builtin.length).toBe(10);
    const names = wfs.map((w) => w.name);
    expect(names).toContain("bughunt");
    expect(names).toContain("deep-research");
    expect(names).toContain("bughunt-lite-mini"); // project origin
    // scif-* flows moved OUT of flow2 to the host repo's .claude/workflows/ —
    // flow2 bakes in NO sciforum flows, only the 10 generic Anthropic built-ins.
    expect(names.filter((n) => n.startsWith("scif-"))).toEqual([]);
  } finally {
    process.chdir(prevCwd);
  }
});

test("resolveWorkflow by name finds a builtin", () => {
  const wf = resolveWorkflow("code-review");
  expect(wf.origin).toBe("builtin");
  expect(wf.name).toBe("code-review");
  expect(wf.source).toContain("export const meta");
});

test("resolveWorkflow by explicit path reads that file", () => {
  const wf = resolveWorkflow(MINI);
  expect(wf.origin).toBe("path");
  expect(wf.name).toBe("bughunt-lite-mini");
});

test("resolveWorkflow throws a helpful error when nothing matches", () => {
  expect(() => resolveWorkflow("no-such-workflow-xyz")).toThrow(/not found/);
});

// ── Finding 1 (CRITICAL) — listWorkflows calls extractMeta on EVERY .flow.js
// just to read meta.name. With the old host `new Function` eval, merely LISTING
// a dir ran every file's meta block. Now the meta evals in a locked realm, so a
// malicious .flow.js is skipped (unparseable) and its payload never fires.
let tmpDir: string | null = null;
let sentinel: string | null = null;
afterEach(() => {
  if (sentinel && fs.existsSync(sentinel)) fs.rmSync(sentinel);
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = sentinel = null;
});

test("listWorkflows over a dir with a malicious .flow.js runs no payload", () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow2-reg-"));
  sentinel = path.join(os.tmpdir(), `flow2-reg-rce-${process.pid}-${Date.now()}.txt`);
  const evil =
    `export const meta = { name: (function(){ ` +
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'pwned'); return 'evil'; })() };\n`;
  fs.writeFileSync(path.join(tmpDir, "evil.flow.js"), evil);
  fs.writeFileSync(
    path.join(tmpDir, "good.flow.js"),
    `export const meta = { name: "good", phases: [] };\n`,
  );

  const wfs = listWorkflows({ project: tmpDir, user: tmpDir, builtin: tmpDir });
  const names = wfs.map((w) => w.name);
  expect(names).toContain("good"); // parseable one is listed
  expect(names).not.toContain("evil"); // malicious one skipped (threw)
  expect(fs.existsSync(sentinel)).toBe(false); // payload never ran
});

// ── Fix B (HIGH) — a malicious `meta` GETTER used to run HOST-side (no timeout)
// when the host read/JSON.stringify'd the returned realm object, so
// `{ get name(){ for(;;){} } }` HUNG `flow2 list`. Now meta is serialized to
// plain data INSIDE the realm under the 1s wall, so a looping getter throws
// in-realm and listWorkflows just skips that file — it does NOT hang.
test("Fix B: listWorkflows over a dir with an infinite-loop meta getter does NOT hang", () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow2-reg-dos-"));
  fs.writeFileSync(
    path.join(tmpDir, "dos.flow.js"),
    `export const meta = { get name(){ for(;;){} } };\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "good.flow.js"),
    `export const meta = { name: "good", phases: [] };\n`,
  );
  const start = Date.now();
  const wfs = listWorkflows({ project: tmpDir, user: tmpDir, builtin: tmpDir });
  const elapsed = Date.now() - start;
  expect(wfs.map((w) => w.name)).toContain("good"); // parseable one is listed
  expect(wfs.map((w) => w.name)).not.toContain("dos"); // malicious one skipped
  expect(elapsed).toBeLessThan(5000); // bounded by the in-realm 1s wall, no host hang
});
