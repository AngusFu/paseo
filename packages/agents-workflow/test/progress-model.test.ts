import { expect, test } from "vitest";
import { createProgressModel } from "../src/progress-model.js";
import { runDemo, renderDashboard } from "../examples/dashboard-demo.js";

test("reducer: phase status + agent lifecycle + per-phase counts + duration", () => {
  let t = 0;
  const now = (): number => t;
  const m = createProgressModel({ name: "W", phases: [{ title: "A" }, { title: "B" }] }, { now });
  const snaps: unknown[] = [];
  m.subscribe((s) => snaps.push(s));

  m.hooks.onPhase("A");
  m.hooks.onAgentEvent({ id: 1, type: "queued", phase: "A", label: "x", model: "M" });
  t = 10;
  m.hooks.onAgentEvent({ id: 1, type: "start", phase: "A", label: "x" });
  t = 30;
  m.hooks.onAgentEvent({ id: 1, type: "complete", phase: "A", usage: { outputTokens: 500 } });
  m.hooks.onPhase("B");

  expect(snaps.length).toBe(5); // one emit per hook call
  const s = m.snapshot();
  expect(s.activePhase).toBe("B");
  expect(s.phases.find((p) => p.title === "A")?.status).toBe("done"); // B started -> A done
  expect(s.phases.find((p) => p.title === "B")?.status).toBe("active");
  expect(s.phases.find((p) => p.title === "A")?.done).toBe(1);
  // agents grouped INTO their phase (tab content), not just a flat list
  expect(s.phases.find((p) => p.title === "A")?.agents.map((x) => x.id)).toEqual([1]);
  expect(s.phases.find((p) => p.title === "B")?.agents).toEqual([]);
  const a = s.agents[0];
  expect(a.status).toBe("done");
  expect(a.tokens).toBe(500);
  expect(a.durationMs).toBe(20); // 30 - 10
  expect(a.model).toBe("M");
  expect(s.stats).toMatchObject({ total: 1, done: 1, failed: 0, running: 0 });
});

test("cache hit: start+complete cached, no queued -> agent is done+cached", () => {
  const m = createProgressModel({ name: "W" });
  m.hooks.onAgentEvent({ id: 1, type: "start", label: "c", cached: true });
  m.hooks.onAgentEvent({ id: 1, type: "complete", label: "c", cached: true });
  const a = m.snapshot().agents[0];
  expect(a.status).toBe("done");
  expect(a.cached).toBe(true);
});

test("snapshot is a deep-frozen readonly clone, decoupled from internal state", () => {
  const m = createProgressModel({ name: "W" });
  m.hooks.onAgentEvent({ id: 1, type: "queued" });
  const s = m.snapshot();
  expect(Object.isFrozen(s)).toBe(true);
  expect(Object.isFrozen(s.agents)).toBe(true);
  expect(Object.isFrozen(s.agents[0])).toBe(true);
  expect(Object.isFrozen(s.stats)).toBe(true);
  // a later update produces a NEW clone; the old one is untouched.
  m.hooks.onAgentEvent({ id: 2, type: "queued" });
  expect(s.agents.length).toBe(1);
  expect(m.snapshot().agents.length).toBe(2);
});

test("subscribe/unsubscribe", () => {
  const m = createProgressModel({ name: "W" });
  let n = 0;
  const off = m.subscribe(() => {
    n++;
  });
  m.hooks.onAgentEvent({ id: 1, type: "queued" });
  off();
  m.hooks.onAgentEvent({ id: 1, type: "start" });
  expect(n).toBe(1); // only the pre-unsubscribe emit counted
});

test("demo: runs the flow end-to-end, final snapshot all-done, renders a dashboard", async () => {
  const { final, frames } = await runDemo();
  expect(frames.length).toBeGreaterThan(5); // streamed many updates
  expect(final.stats.total).toBe(5 + 4 + 4); // 13 agents across 3 phases
  expect(final.stats.done).toBe(13);
  expect(final.stats.failed).toBe(0);
  expect(final.phases.every((p) => p.total === p.done && p.total > 0)).toBe(true);
  expect(final.activePhase).toBe("Infrastructure"); // last phase() call (imperative)
  // phases[].agents grouping — tab content is ready per phase
  const inv = final.phases.find((p) => p.title === "Inventory");
  expect(inv?.agents.length).toBe(5);
  expect(inv?.agents.every((x) => x.phase === "Inventory")).toBe(true);

  // render TWO different tabs off the SAME snapshot — proves phase switching is a
  // pure view choice (selectedPhase arg), no model/engine round-trip.
  const tabInfra = renderDashboard(final, "Infrastructure");
  const tabInventory = renderDashboard(final, "Inventory");
  expect(tabInfra).toContain("infra:package.json");
  expect(tabInfra).not.toContain("inv:components");
  expect(tabInventory).toContain("inv:components");
  expect(tabInventory).not.toContain("infra:package.json");
  console.log(
    "\n[TAB → Infrastructure]\n" + tabInfra + "\n\n[TAB → Inventory]\n" + tabInventory + "\n",
  );
});
