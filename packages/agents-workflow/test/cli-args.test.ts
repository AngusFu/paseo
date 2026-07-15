// cli-args: pure arg-merge + journal-path logic pulled out of cli.ts so it's
// unit-testable without spawning the process. covers: yargs-parser conventions
// (kebab->camel, number coercion, --no-x negation), named --<key> flags ->
// `args` object (reserved flags excluded), --args json base + named overlay
// (named wins), bare-string --args passthrough (deep-research), the journal
// default-path derivation + --no-journal + resume-no-wipe rules, and the
// runtimeDir/key default-derivation helpers.
import { test, expect } from "vitest";
import * as path from "node:path";
import {
  parseArgs,
  collectNamedArgs,
  buildAgentArgs,
  ArgsError,
  deriveDefaultJournalPath,
  resolveJournalPlan,
  slugifyTicketId,
  deriveDefaultKey,
  deriveDefaultRuntimeDir,
  applyRuntimeDefaults,
} from "../src/cli-args.js";

// ── parseArgs (the flat --key value / --key boolean collector) ──
test("parseArgs collects --key value, valueless --key as boolean, and positionals", () => {
  const out = parseArgs(["run", "bug", "--ticketId", "SCIF-1", "--trace", "--key", "k"]);
  expect(out._).toEqual(["run", "bug"]);
  expect(out.ticketId).toBe("SCIF-1");
  expect(out.trace).toBe(true);
  expect(out.key).toBe("k");
});

// ── kebab -> camel expansion (community convention) ──
test("parseArgs expands kebab-case flags to camelCase and drops the kebab duplicate", () => {
  const out = parseArgs(["run", "bug", "--runtime-dir", "/tmp/r", "--wait-timeout", "5m"]);
  expect(out.runtimeDir).toBe("/tmp/r");
  expect(out.waitTimeout).toBe("5m");
  expect(out["runtime-dir"]).toBeUndefined();
  expect(out["wait-timeout"]).toBeUndefined();
});

// ── number coercion ON, leading-zero strings stay strings ──
test("parseArgs coerces plain numeric values to numbers but keeps leading-zero strings", () => {
  const out = parseArgs(["run", "bug", "--budget", "500", "--zero", "007"]);
  expect(out.budget).toBe(500);
  expect(typeof out.budget).toBe("number");
  expect(out.zero).toBe("007");
  expect(typeof out.zero).toBe("string");
});

// ── identity keys forced to string even when the value looks numeric ──
test("parseArgs forces ticketId/key/runtimeDir to stay strings even when purely numeric", () => {
  const out = parseArgs([
    "run",
    "bug",
    "--ticketId",
    "1234",
    "--key",
    "5678",
    "--runtimeDir",
    "999",
  ]);
  expect(out.ticketId).toBe("1234");
  expect(out.key).toBe("5678");
  expect(out.runtimeDir).toBe("999");
});

// ── --no-x negation ON: collapses onto the base key ──
test("parseArgs: --no-journal/--no-strict negate onto the base key", () => {
  const out = parseArgs(["run", "bug", "--no-journal", "--no-strict"]);
  expect(out.journal).toBe(false);
  expect(out.strict).toBe(false);
});

// ── --key=value form also works (yargs-parser handles both = and space) ──
test("parseArgs accepts --key=value form same as --key value", () => {
  const out = parseArgs(["run", "bug", "--ticketId=SCIF-9"]);
  expect(out.ticketId).toBe("SCIF-9");
});

// ── collectNamedArgs: "true"/"false" string values -> boolean for named script args ──
test('collectNamedArgs converts a collected "true"/"false" string value to a real boolean', () => {
  const parsed = parseArgs(["run", "bug", "--dryRun", "true", "--verbose", "false"]);
  const named = collectNamedArgs(parsed);
  expect(named).toEqual({ dryRun: true, verbose: false });
});

// ── collectNamedArgs: identity keys stay string even if literally "true"/"false" ──
test('collectNamedArgs leaves identity keys as strings even for the pathological "true" value', () => {
  const parsed = parseArgs(["run", "bug", "--ticketId", "true"]);
  const named = collectNamedArgs(parsed);
  expect(named).toEqual({ ticketId: "true" });
});

// ── collectNamedArgs / RESERVED_FLAGS exclusion (kebab forms in argv, camelCase reserved set) ──
test("collectNamedArgs excludes reserved flags (given as kebab-case argv) and `_`", () => {
  const parsed = parseArgs([
    "run",
    "bug",
    "--backend",
    "mock",
    "--mock",
    "auto",
    "--provider",
    "claude",
    "--wait-timeout",
    "5m",
    "--cwd",
    "/x",
    "--journal",
    "/j",
    "--no-journal",
    "--resume",
    "/r",
    "--max-concurrency",
    "4",
    "--max-agents",
    "10",
    "--budget",
    "500",
    "--no-strict",
    "--trace",
    "--quiet",
    "--args",
    '{"a":1}',
    "--ticketId",
    "SCIF-1",
    "--runtimeDir",
    "/tmp/r",
    "--key",
    "k",
  ]);
  const named = collectNamedArgs(parsed);
  expect(named).toEqual({ ticketId: "SCIF-1", runtimeDir: "/tmp/r", key: "k" });
});

// ── same reserved-flag exclusion, but given in camelCase argv (no kebab at all) ──
test("collectNamedArgs excludes reserved flags given as camelCase argv too", () => {
  const parsed = parseArgs([
    "run",
    "bug",
    "--backend",
    "mock",
    "--waitTimeout",
    "5m",
    "--maxConcurrency",
    "4",
    "--maxAgents",
    "10",
    "--budget",
    "500",
    "--trace",
    "--quiet",
    "--ticketId",
    "SCIF-1",
    "--runtimeDir",
    "/tmp/r",
    "--key",
    "k",
  ]);
  const named = collectNamedArgs(parsed);
  expect(named).toEqual({ ticketId: "SCIF-1", runtimeDir: "/tmp/r", key: "k" });
});

// ── buildAgentArgs: named flags alone -> args object ──
test("buildAgentArgs: named flags alone build the args object", () => {
  const parsed = parseArgs([
    "run",
    "bug",
    "--ticketId",
    "SCIF-1",
    "--runtimeDir",
    "/tmp/r",
    "--key",
    "k",
  ]);
  expect(buildAgentArgs(parsed)).toEqual({ ticketId: "SCIF-1", runtimeDir: "/tmp/r", key: "k" });
});

// ── buildAgentArgs: valueless --<key> -> true ──
test("buildAgentArgs: valueless named flag becomes boolean true", () => {
  const parsed = parseArgs(["run", "bug", "--dryRun"]);
  expect(buildAgentArgs(parsed)).toEqual({ dryRun: true });
});

// ── buildAgentArgs: --args json base + named overlay, named WINS ──
test("buildAgentArgs: --args json base overlaid by named flags, named wins on collision", () => {
  const parsed = parseArgs([
    "run",
    "bug",
    "--args",
    '{"ticketId":"OLD","extra":true}',
    "--ticketId",
    "NEW",
    "--key",
    "k",
  ]);
  expect(buildAgentArgs(parsed)).toEqual({ ticketId: "NEW", extra: true, key: "k" });
});

// ── buildAgentArgs: bare-string --args with NO named flags passes through (deep-research) ──
test("buildAgentArgs: bare-string --args with no named flags passes through verbatim", () => {
  const parsed = parseArgs(["run", "deep-research", "--args", '"my research question"']);
  expect(buildAgentArgs(parsed)).toBe("my research question");
});

test("buildAgentArgs: bare-array --args with no named flags passes through verbatim", () => {
  const parsed = parseArgs(["run", "x", "--args", "[1,2,3]"]);
  expect(buildAgentArgs(parsed)).toEqual([1, 2, 3]);
});

// ── buildAgentArgs: bare-string --args PLUS named flags -> can't merge, error ──
test("buildAgentArgs: bare-string --args plus named flags throws ArgsError", () => {
  const parsed = parseArgs(["run", "x", "--args", '"just a string"', "--ticketId", "X"]);
  expect(() => buildAgentArgs(parsed)).toThrow(ArgsError);
});

// ── buildAgentArgs: invalid JSON --args -> ArgsError (today's exit-2 case) ──
test("buildAgentArgs: invalid JSON --args throws ArgsError", () => {
  const parsed = parseArgs(["run", "bug", "--args", "{not json"]);
  expect(() => buildAgentArgs(parsed)).toThrow(ArgsError);
});

// ── buildAgentArgs: non-string --args -> ArgsError (defensive; parseArgs itself
// forces `args` to string, so this only fires when a ParsedArgs is built by hand) ──
test("buildAgentArgs: non-string --args value throws ArgsError", () => {
  expect(() => buildAgentArgs({ _: [], args: true })).toThrow(ArgsError);
});

// ── buildAgentArgs: neither --args nor named flags -> null (today's default) ──
test("buildAgentArgs: no --args and no named flags returns null", () => {
  const parsed = parseArgs(["run", "bug"]);
  expect(buildAgentArgs(parsed)).toBe(null);
});

// ── journal default-path derivation ──
test("deriveDefaultJournalPath: co-locates with the gated artifact sandbox when runtimeDir+key present", () => {
  const p = deriveDefaultJournalPath(
    { ticketId: "X", runtimeDir: "/tmp/r", key: "k" },
    "/cwd",
    "bug",
  );
  expect(p).toBe(path.join("/tmp/r", "k", "journal.jsonl"));
});

test("deriveDefaultJournalPath: falls back to cwd/.aw/journal/<workflow>.jsonl otherwise", () => {
  expect(deriveDefaultJournalPath(null, "/cwd", "bug")).toBe(
    path.join("/cwd", ".aw", "journal", "bug.jsonl"),
  );
  expect(deriveDefaultJournalPath({ ticketId: "X" }, "/cwd", "deep-research")).toBe(
    path.join("/cwd", ".aw", "journal", "deep-research.jsonl"),
  );
  expect(deriveDefaultJournalPath("bare string arg", "/cwd", "deep-research")).toBe(
    path.join("/cwd", ".aw", "journal", "deep-research.jsonl"),
  );
});

// ── resolveJournalPlan: default ON, --journal, --no-journal, --resume ──
test("resolveJournalPlan: default ON derives the stable path and wipes fresh", () => {
  const plan = resolveJournalPlan({
    agentArgs: { runtimeDir: "/tmp/r", key: "k" },
    cwd: "/cwd",
    workflowName: "bug",
  });
  expect(plan.path).toBe(path.join("/tmp/r", "k", "journal.jsonl"));
  expect(plan.wipeIfExists).toBe(true);
});

test("resolveJournalPlan: --no-journal disables (path null)", () => {
  const plan = resolveJournalPlan({
    noJournal: true,
    agentArgs: { runtimeDir: "/tmp/r", key: "k" },
    cwd: "/cwd",
    workflowName: "bug",
  });
  expect(plan.path).toBe(null);
  expect(plan.wipeIfExists).toBe(false);
});

test("resolveJournalPlan: explicit --journal wins and wipes (today's fresh-mirror behavior)", () => {
  const plan = resolveJournalPlan({
    journalFlag: "/explicit/j.jsonl",
    agentArgs: { runtimeDir: "/tmp/r", key: "k" },
    cwd: "/cwd",
    workflowName: "bug",
  });
  expect(plan.path).toBe("/explicit/j.jsonl");
  expect(plan.wipeIfExists).toBe(true);
});

test("resolveJournalPlan: --resume alone reuses that path and does NOT wipe it", () => {
  const plan = resolveJournalPlan({
    resumeFlag: "/tmp/old-journal.jsonl",
    agentArgs: { runtimeDir: "/tmp/r", key: "k" },
    cwd: "/cwd",
    workflowName: "bug",
  });
  expect(plan.path).toBe("/tmp/old-journal.jsonl");
  expect(plan.wipeIfExists).toBe(false);
});

// ── slugifyTicketId ──
test("slugifyTicketId lowercases and collapses non [a-z0-9] runs into a single dash", () => {
  expect(slugifyTicketId("SCIF-1234")).toBe("scif-1234");
  expect(slugifyTicketId("SCIF_1234 (dup!)")).toBe("scif-1234-dup"); // underscore/space/paren all non [a-z0-9] -> dash runs
});

test("slugifyTicketId trims leading/trailing dashes produced by non-alnum edges", () => {
  expect(slugifyTicketId("--SCIF-1234--")).toBe("scif-1234");
  expect(slugifyTicketId("  weird/ticket:99  ")).toBe("weird-ticket-99");
});

// ── deriveDefaultKey ──
test("deriveDefaultKey: slugs the ticketId when given", () => {
  expect(deriveDefaultKey("SCIF-777", 111)).toBe("scif-777");
});

test("deriveDefaultKey: falls back to run-<now> when no ticketId string", () => {
  expect(deriveDefaultKey(undefined, 123456)).toBe("run-123456");
  expect(deriveDefaultKey("", 123456)).toBe("run-123456");
  expect(deriveDefaultKey(42, 123456)).toBe("run-123456"); // non-string ticketId (shouldn't happen, identity keys stay string) -> fallback
});

// ── deriveDefaultRuntimeDir ──
test("deriveDefaultRuntimeDir: AW_RUNTIME_DIR env wins over everything", () => {
  expect(
    deriveDefaultRuntimeDir({ AW_RUNTIME_DIR: "/env/rd", XDG_STATE_HOME: "/xdg" }, "/cwd"),
  ).toBe("/env/rd");
});

test("deriveDefaultRuntimeDir: XDG_STATE_HOME/aw when no AW_RUNTIME_DIR", () => {
  expect(deriveDefaultRuntimeDir({ XDG_STATE_HOME: "/xdg" }, "/cwd")).toBe(path.join("/xdg", "aw"));
});

test("deriveDefaultRuntimeDir: falls back to cwd/.aw when neither env var is set", () => {
  expect(deriveDefaultRuntimeDir({}, "/cwd")).toBe(path.join("/cwd", ".aw"));
});

// ── applyRuntimeDefaults ──
test("applyRuntimeDefaults: injects key (ticketId slug) + runtimeDir (cwd fallback) when absent", () => {
  const out = applyRuntimeDefaults({ ticketId: "SCIF-777" }, { env: {}, cwd: "/cwd", now: 999 });
  expect(out).toEqual({
    ticketId: "SCIF-777",
    key: "scif-777",
    runtimeDir: path.join("/cwd", ".aw"),
  });
});

test("applyRuntimeDefaults: run-<now> key when no ticketId given at all", () => {
  const out = applyRuntimeDefaults({}, { env: {}, cwd: "/cwd", now: 999 });
  expect(out).toEqual({ key: "run-999", runtimeDir: path.join("/cwd", ".aw") });
});

test("applyRuntimeDefaults: explicit runtimeDir/key are never overridden", () => {
  const out = applyRuntimeDefaults(
    { ticketId: "SCIF-1", runtimeDir: "/tmp/rd", key: "k" },
    { env: { AW_RUNTIME_DIR: "/should-not-be-used" }, cwd: "/cwd", now: 999 },
  );
  expect(out).toEqual({ ticketId: "SCIF-1", runtimeDir: "/tmp/rd", key: "k" });
});

test("applyRuntimeDefaults: honors AW_RUNTIME_DIR env override for runtimeDir", () => {
  const out = applyRuntimeDefaults(
    { ticketId: "SCIF-1" },
    { env: { AW_RUNTIME_DIR: "/env/rd" }, cwd: "/cwd", now: 999 },
  );
  expect(out).toEqual({ ticketId: "SCIF-1", key: "scif-1", runtimeDir: "/env/rd" });
});

test("applyRuntimeDefaults: does NOT inject into bare-string or bare-array agentArgs (deep-research)", () => {
  expect(applyRuntimeDefaults("my research question", { env: {}, cwd: "/cwd", now: 999 })).toBe(
    "my research question",
  );
  expect(applyRuntimeDefaults([1, 2, 3], { env: {}, cwd: "/cwd", now: 999 })).toEqual([1, 2, 3]);
  expect(applyRuntimeDefaults(null, { env: {}, cwd: "/cwd", now: 999 })).toBe(null);
});
