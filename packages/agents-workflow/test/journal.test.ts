// journal file-backed path: record mirrors to JSONL, reload replays it, and a
// corrupt line is skipped. (engine tests already cover the in-memory path.)
import { test, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Journal, agentKey } from "../src/journal.js";

let tmp: string | null = null;
afterEach(() => {
  if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp);
  tmp = null;
});

function tmpFile(): string {
  tmp = path.join(
    os.tmpdir(),
    `flow2-journal-${process.pid}-${Math.floor(performance.now())}.jsonl`,
  );
  return tmp;
}

test("agentKey is deterministic and opts-sensitive", () => {
  expect(agentKey("p")).toBe(agentKey("p"));
  expect(agentKey("p")).not.toBe(agentKey("p", { model: "x" }));
  expect(agentKey("p").startsWith("wf_")).toBe(true);
});

test("record mirrors to a JSONL file and reload replays it", () => {
  const file = tmpFile();
  const j = new Journal({ path: file });
  j.record("k1", { a: 1 });
  j.record("k2", "text");
  expect(j.size).toBe(2);

  const reloaded = new Journal({ path: file });
  expect(reloaded.has("k1")).toBe(true);
  expect(reloaded.get("k1")).toEqual({ a: 1 });
  expect(reloaded.get("k2")).toBe("text");
  expect(reloaded.size).toBe(2);
});

test("reload skips corrupt lines", () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"key":"good","result":1}\nNOT JSON\n\n{"key":"good2","result":2}\n');
  const j = new Journal({ path: file });
  expect(j.size).toBe(2);
  expect(j.get("good")).toBe(1);
  expect(j.get("good2")).toBe(2);
});

test("in-memory journal has null path", () => {
  expect(new Journal().path).toBe(null);
});

// ── Finding 3 (HIGH) — two DIFFERENT zod schemas used to serialize to
// near-identical bytes (`.shape` is a dropped getter) and COLLIDE on one
// journal key -> a call with schema B could return schema A's cached value
// (validation bypass). Fingerprinting off the canonical json shape fixes it.
test("Finding 3: different zod schemas produce DIFFERENT keys (no collision)", () => {
  const a = z.object({ a: z.number() });
  const b = z.object({ b: z.string() });
  expect(agentKey("p", { schema: a })).not.toBe(agentKey("p", { schema: b }));
  // same schema is stable (still a cache hit for a genuine repeat).
  expect(agentKey("p", { schema: a })).toBe(agentKey("p", { schema: z.object({ a: z.number() }) }));
});

// a JSON-Schema object path differs too, and the wrong-cache-hit scenario is
// gone: two prompts+schemas that a naive key merged now separate.
test("Finding 3: different JSON-Schema objects produce different keys", () => {
  const a = { type: "object", properties: { x: { type: "number" } } };
  const b = { type: "object", properties: { x: { type: "string" } } };
  expect(agentKey("p", { schema: a })).not.toBe(agentKey("p", { schema: b }));
});

// ── Finding 6 (LOW) — key now folds in label/phase; two calls that differ ONLY
// in label or phase must not share a cache slot.
test("Finding 6: key folds in label and phase", () => {
  expect(agentKey("p", { label: "A" })).not.toBe(agentKey("p", { label: "B" }));
  expect(agentKey("p", { phase: "X" })).not.toBe(agentKey("p", { phase: "Y" }));
});

// a genuine repeat (same prompt+opts) is still a stable cache hit.
test("agentKey is stable for identical calls", () => {
  expect(agentKey("p")).toBe(agentKey("p"));
});

// ── review 2026-07-18 #3 — isolation/labels were missing from the key.
test("review #3: key folds in isolation and labels", () => {
  expect(agentKey("p", { isolation: "worktree" })).not.toBe(agentKey("p"));
  expect(agentKey("p", { labels: { a: "1" } })).not.toBe(agentKey("p", { labels: { a: "2" } }));
});

// ── review 2026-07-18 #3 — replay semantics: only entries recorded BEFORE the
// current run (beginRun snapshot) are served; live-run records are not.
test("review #3: canReplay serves pre-run entries only", () => {
  const j = new Journal();
  j.record("old", 1);
  j.beginRun();
  j.record("new", 2);
  expect(j.canReplay("old")).toBe(true);
  expect(j.canReplay("new")).toBe(false);
  expect(j.has("new")).toBe(true); // still stored (persists for the NEXT run)
  j.beginRun();
  expect(j.canReplay("new")).toBe(true);
});

test("review #3: a file-reloaded journal is replayable immediately", () => {
  const file = tmpFile();
  new Journal({ path: file }).record("k", "v");
  expect(new Journal({ path: file }).canReplay("k")).toBe(true);
});
