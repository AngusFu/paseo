// Headless progress-model demo. Shows the engine's DATA MODEL (createProgressModel)
// driving a plain text renderer — the model is view-agnostic, the renderer is a pure
// (snapshot) => string the consumer owns. Swap renderDashboard for React/Solid/HTML;
// the data model does not change.
//
// Run it (node 20 can't strip TS, so use the test or build first):
//   pnpm build && node dist/examples/dashboard-demo.js      # if examples are built
//   — or — `pnpm test progress-model` prints the final frame.
// import from the public SDK surface (src/index.ts) — everything the demo needs
// (createEngine / extractMeta / MockBackend / createProgressModel + types) is exported there.
import {
  createEngine,
  extractMeta,
  MockBackend,
  createProgressModel,
  type WorkflowSnapshot,
  type AgentView,
} from "../src/index.js";

// ── a sample flow: 3 phases, each a parallel batch of file agents ──
export const demoSource = `
export const meta = {
  name: 'react-to-solid-migration',
  description: 'Non-destructive React -> Solid.js port of Excalidraw, headless-progress demo',
  phases: [
    { title: 'Inventory', detail: 'Scan the source tree' },
    { title: 'Pattern Analysis', detail: 'Detect React patterns' },
    { title: 'Infrastructure', detail: 'Port config + entry points' },
  ],
}
phase('Inventory')
await parallel(args.inventory.map((f) => () => agent('inventory ' + f, { label: 'inv:' + f, phase: 'Inventory' })))
phase('Pattern Analysis')
await parallel(args.patterns.map((f) => () => agent('analyze ' + f, { label: 'pat:' + f, phase: 'Pattern Analysis' })))
phase('Infrastructure')
await parallel(args.infra.map((f) => () => agent('port ' + f, { label: 'infra:' + f, phase: 'Infrastructure', model: 'claude-opus-4-8' })))
return 'done'
`;

const DEMO_ARGS = {
  inventory: ["components", "hooks", "utils", "types", "assets"],
  patterns: ["jsx", "context", "effects", "refs"],
  infra: ["package.json", "vite.config.ts", "tsconfig.json", "index.tsx"],
};

// deterministic per-label token count so runs look varied but reproducible.
function tokensFor(label: string | undefined): number {
  let h = 0;
  for (const c of label ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 40000 + (h % 12000);
}

// ── the renderer: PURE (snapshot) => string. Owned by the consumer, not the engine. ──
const ICON: Record<AgentView["status"], string> = {
  queued: "○",
  running: "⟳",
  retrying: "⟳",
  done: "✔",
  failed: "✗",
};
const PHASE_ICON: Record<string, string> = { pending: "○", active: "›", done: "✔" };
const k = (n: number | undefined): string => (n === undefined ? "-" : (n / 1000).toFixed(1) + "k");

// selectedPhase = which phase TAB the user is viewing (a VIEW choice, defaults to the
// active phase). The model owns no selection — the consumer passes whichever tab is open.
export function renderDashboard(
  s: WorkflowSnapshot,
  selectedPhase: string | undefined = s.activePhase,
): string {
  const out: string[] = [];
  const donePhases = s.phases.filter((p) => p.status === "done").length;
  out.push(
    `${s.name}   [${donePhases}/${s.phases.length} phases]   ` +
      `${s.stats.done} done · ${s.stats.running + s.stats.retrying} running · ${s.stats.total} total · ${(s.elapsedMs / 1000).toFixed(1)}s`,
  );
  out.push(s.description ?? "");
  // phase TABS — ▶ marks the selected one; the icon shows pending/active/done.
  out.push("Phases (tabs — click to switch):");
  for (const p of s.phases) {
    const sel = p.title === selectedPhase ? "▶ " : "  ";
    out.push(`  ${sel}${PHASE_ICON[p.status]} ${p.title.padEnd(20)} ${p.done}/${p.total}`);
  }
  // the SELECTED tab's content — straight off phases[selected].agents, no filtering.
  const tab = s.phases.find((p) => p.title === selectedPhase);
  if (tab) {
    out.push(`${tab.title} · ${tab.agents.length} agents:`);
    for (const a of tab.agents) {
      const dur =
        a.durationMs !== undefined ? `${a.durationMs}ms` : a.status === "running" ? "…" : "-";
      out.push(
        `  ${ICON[a.status]} ${(a.label ?? "agent#" + a.id).padEnd(20)} ${(a.model ?? "default").padEnd(18)} ${k(a.tokens)} tok · ${dur}`,
      );
    }
  }
  return out.join("\n");
}

// ── run the flow through the engine + the progress model, collecting frames ──
export async function runDemo(
  opts: { onFrame?: (s: WorkflowSnapshot) => void } = {},
): Promise<{ frames: WorkflowSnapshot[]; final: WorkflowSnapshot }> {
  const backend = new MockBackend({
    latencyMs: 8,
    respond: (spec) => ({ text: "ok", usage: { outputTokens: tokensFor(spec.label) } }),
  });
  const meta = extractMeta(demoSource).meta;
  const model = createProgressModel(meta);
  const frames: WorkflowSnapshot[] = [];
  model.subscribe((snap) => {
    frames.push(snap);
    opts.onFrame?.(snap);
  });
  const engine = createEngine({ backend, ...model.hooks });
  await engine.run(demoSource, { args: DEMO_ARGS });
  return { frames, final: model.snapshot() };
}

// standalone entry (only runs when executed directly, not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().then(({ final }) => {
    console.log(renderDashboard(final));
  });
}
