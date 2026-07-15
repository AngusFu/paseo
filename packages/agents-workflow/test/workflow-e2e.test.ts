// ported from flowkit test/workflow-e2e.test.ts (node:test -> vitest) + a new
// test proving MockBackend parses+runs ALL 10 builtins.
import { test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine.js";
import { MockBackend } from "../src/backends/mock.js";
import { Journal } from "../src/journal.js";
import { listWorkflows } from "../src/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF = fs.readFileSync(
  path.join(__dirname, "..", "workflows", "bughunt-lite-mini.flow.js"),
  "utf-8",
);

/**
 * A scripted "coding agent" that plays every role in the workflow, keyed off the
 * assembled prompt/label. This is exactly how a real backend's agents would
 * respond — the mock just returns canned JSON instead of calling an LLM.
 */
function coder() {
  return MockBackend.scripted({
    scope: { text: JSON.stringify({ diffBase: "origin/main", files: ["src/a.js", "src/b.js"] }) },
    "rapid-0": {
      text: JSON.stringify({
        bugs: [
          { file: "src/a.js", line: 10, title: "null deref", severity: "high" },
          { file: "src/b.js", line: 20, title: "race condition", severity: "critical" },
        ],
      }),
    },
    "rapid-1": {
      text: JSON.stringify({
        bugs: [
          { file: "src/a.js", line: 11, title: "null deref (dupe)", severity: "high" },
          { file: "src/b.js", line: 44, title: "leaked handle", severity: "medium" },
        ],
      }),
    },
    "deep-0": {
      text: JSON.stringify({
        bugs: [{ file: "src/a.js", line: 70, title: "off-by-one", severity: "low" }],
      }),
    },
    Verify: (spec) => {
      const isOffByOne = spec.prompt.includes("off-by-one");
      return {
        text: JSON.stringify({
          refuted: isOffByOne,
          evidence: isOffByOne ? "guarded upstream" : "confirmed reachable",
        }),
      };
    },
    synthesize: (spec) => {
      const titles = [...spec.prompt.matchAll(/\[\d+\] (.*?) \(/g)].map((m) => m[1]);
      return {
        text: JSON.stringify({
          summary: titles.length + " real bugs found.",
          bugs: titles.map((t) => ({ title: t, severity: "high" })),
        }),
      };
    },
  });
}

test("e2e: bughunt-lite-mini runs end-to-end on MockBackend", async () => {
  const logs: string[] = [],
    phases: string[] = [];
  const backend = new MockBackend({ respond: coder() });
  const engine = createEngine({
    backend,
    maxConcurrency: 8,
    onLog: (m) => logs.push(m),
    onPhase: (p) => phases.push(p),
  });

  const { meta, result, stats } = await engine.run(WF);
  const r = result as {
    stats: { voted: number; confirmed: number };
    bugs: unknown[];
    summary: string;
  };

  expect(meta.name).toBe("bughunt-lite-mini");
  expect(meta.phases!.length).toBe(4);
  expect(phases).toEqual(["Scope", "Find", "Synthesize"]);
  expect(r.stats.voted).toBe(4);
  expect(r.stats.confirmed).toBe(3);
  expect(r.bugs.length).toBe(3);
  expect(r.summary).toMatch(/3 real bugs/);
  expect(backend.calls.length).toBeGreaterThanOrEqual(1 + 3 + 12 + 1);
  expect(logs.some((l) => l.includes("scope:"))).toBe(true);
  expect(stats.agentCalls).toBe(backend.calls.length);
});

test("e2e: same workflow is backend-agnostic — a second backend yields the same shape", async () => {
  const mk = () => new MockBackend({ respond: coder() });
  const a = await createEngine({ backend: mk() }).run(WF);
  const b = await createEngine({ backend: mk() }).run(WF);
  expect((a.result as { stats: { confirmed: number } }).stats.confirmed).toBe(
    (b.result as { stats: { confirmed: number } }).stats.confirmed,
  );
  expect((a.result as { summary: string }).summary).toBe((b.result as { summary: string }).summary);
});

test("e2e: determinism — resume via journal skips all backend calls", async () => {
  const journal = new Journal();
  const first = new MockBackend({ respond: coder() });
  await createEngine({ backend: first, journal }).run(WF);
  const callsFirst = first.calls.length;
  expect(callsFirst).toBeGreaterThan(0);

  const second = new MockBackend({ respond: () => ({ error: "must not run" }) });
  const { result, stats } = await createEngine({ backend: second, journal }).run(WF);
  expect(second.calls.length).toBe(0);
  expect((result as { stats: { confirmed: number } }).stats.confirmed).toBe(3);
  expect(stats.cacheHits).toBe(callsFirst);
});

test("e2e: MockBackend.auto() parses + runs ALL 10 builtins to completion", async () => {
  // builtin/ is exactly the 10 inline-schema Claude-Workflow .flow.js flows
  // (the gated sciforum scif-* flows moved OUT of flow2 to the host repo).
  const builtins = listWorkflows().filter(
    (w) => w.origin === "builtin" && w.path.endsWith(".flow.js"),
  );
  expect(builtins.length).toBe(10);
  for (const wf of builtins) {
    const backend = new MockBackend({ respond: MockBackend.auto() });
    const engine = createEngine({ backend, maxConcurrency: 8 });
    // a string arg satisfies the task-guard the autopilot-family workflows use,
    // so each one proceeds past the guard and actually exercises agent().
    const { result, stats } = await engine.run(wf.source, { args: "do the thing" });
    expect(result, `builtin "${wf.name}" produced no result`).toBeDefined();
    expect(stats.agentCalls, `builtin "${wf.name}" never called agent()`).toBeGreaterThan(0);
  }
});
