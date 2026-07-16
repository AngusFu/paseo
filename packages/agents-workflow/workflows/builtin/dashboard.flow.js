/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "dashboard",
  description:
    "Dashboard generator. Discovers data sources and existing dashboard conventions in the repo, designs a panel layout, implements it, dry-runs queries and render-checks the result, then opens a PR.",
  whenToUse:
    "When the user wants a dashboard, monitoring view, or metrics page built. This workflow finds the available data and existing dashboard patterns, specs out panels and layout, implements them, validates queries and rendering, and opens a PR.",
  phases: [
    { title: "Discover", detail: "Data sources, existing dashboard libs/patterns in repo" },
    { title: "Design", detail: "Panels, metrics, layout spec" },
    { title: "Implement", detail: "Build the dashboard" },
    { title: "Verify", detail: "Query dry-run, render/screenshot if possible" },
    { title: "PR", detail: "Open PR" },
  ],
};

const TASK =
  typeof args === "string" && args.trim()
    ? args.trim()
    : typeof args === "object" && args && typeof args.task === "string" && args.task.trim()
      ? args.task.trim()
      : typeof args === "object" && args && typeof args.prompt === "string" && args.prompt.trim()
        ? args.prompt.trim()
        : "";
if (!TASK) return { error: "No dashboard description provided. Pass what to build as args." };

const DISCOVER_SCHEMA = {
  type: "object",
  required: ["dataSources", "framework", "examplePath", "targetPath"],
  properties: {
    dataSources: {
      type: "array",
      items: { type: "string" },
      description: "Tables, metrics, APIs, or log streams available",
    },
    framework: {
      type: "string",
      description: "Dashboard system in use (Grafana JSON, Hex, React+charts lib, Streamlit, etc.)",
    },
    examplePath: { type: "string", description: "Path to an existing dashboard to pattern-match" },
    targetPath: { type: "string" },
    conventions: { type: "string" },
  },
};
const DESIGN_SCHEMA = {
  type: "object",
  required: ["title", "panels"],
  properties: {
    title: { type: "string" },
    panels: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "metric", "viz"],
        properties: {
          name: { type: "string" },
          metric: { type: "string", description: "Query or metric expression" },
          viz: { type: "string", description: "timeseries, stat, table, bar, etc." },
          why: { type: "string" },
        },
      },
    },
    layout: { type: "string" },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const VERIFY_SCHEMA = {
  type: "object",
  required: ["queriesOk", "rendered", "issues"],
  properties: {
    queriesOk: { type: "boolean" },
    rendered: { type: "boolean" },
    screenshotPath: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Discover ═══
phase("Discover");

const disc = await agent(
  "Discover the dashboard stack and available data for this request.\n\n" +
    "## Request\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify the dashboard framework this repo uses: Grafana-as-code, Hex, Datadog JSON, " +
    "Streamlit, a React page with a charting library, or similar. Grep for existing dashboards.\n" +
    "2. Find an existing dashboard file to pattern-match against (examplePath).\n" +
    "3. List concrete data sources relevant to the request: table names, metric names, API " +
    "endpoints, or log queries. Verify they exist where possible.\n" +
    "4. Decide where the new dashboard file(s) should live (targetPath) and note conventions.",
  { label: "discover", schema: DISCOVER_SCHEMA },
);
if (!disc) return { error: "Discover step skipped." };
log(
  "Framework: " +
    disc.framework +
    ", " +
    disc.dataSources.length +
    " data sources, target: " +
    disc.targetPath,
);

const CONTEXT =
  "## Request\n" +
  TASK +
  "\n\n" +
  "## Framework\n" +
  disc.framework +
  " (pattern: " +
  disc.examplePath +
  ")\n\n" +
  "## Data sources\n" +
  disc.dataSources.map((d) => "- " + d).join("\n") +
  "\n\n" +
  "## Conventions\n" +
  (disc.conventions || "(none noted)") +
  "\n";

// ═══ Phase 2: Design ═══
phase("Design");

const design = await agent(
  CONTEXT +
    "\n## Instructions\n" +
    "Design the dashboard. For each panel specify: name, the exact metric/query expression, " +
    "visualization type, and a one-line reason it earns a spot.\n\n" +
    "Best practices:\n" +
    "- Top row = the headline numbers (what is the state right now). Below = breakdowns and trends.\n" +
    "- Prefer rates and percentiles over raw counts. Pair every latency panel with a volume panel.\n" +
    "- Every panel should answer a question someone would actually ask. Cut anything that does not.\n" +
    "- 6-12 panels is usually right. More than that and nothing gets looked at.\n" +
    "Describe layout as a brief grid spec.",
  { label: "design", schema: DESIGN_SCHEMA },
);
if (!design) return { error: "Design step skipped.", discover: disc };
log("Design: " + design.panels.length + " panels");

// ═══ Phase 3: Implement ═══
phase("Implement");

const impl = await agent(
  CONTEXT +
    "\n## Design\n" +
    "Title: " +
    design.title +
    "\n" +
    "Layout: " +
    (design.layout || "(default grid)") +
    "\n" +
    "Panels:\n" +
    design.panels
      .map((p, i) => i + 1 + ". " + p.name + " [" + p.viz + "] — " + p.metric)
      .join("\n") +
    "\n\n" +
    "## Instructions\n" +
    "Implement the dashboard at " +
    disc.targetPath +
    " using " +
    disc.framework +
    ".\n" +
    "Match the structure of " +
    disc.examplePath +
    " exactly — same JSON schema, component " +
    "patterns, or DSL. Wire up each panel to its data source.\n" +
    "Register the dashboard in any index/nav file the framework requires.",
  { label: "implement", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Implementation incomplete.",
    discover: disc,
    design,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Implemented: " + impl.filesChanged.length + " files");

// ═══ Phase 4: Verify ═══
phase("Verify");

const verify = await agent(
  "Verify the dashboard.\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n" +
    "Framework: " +
    disc.framework +
    "\n\n" +
    "## Instructions\n" +
    "1. Dry-run or validate every query/metric expression — confirm syntax and that the " +
    "referenced tables/metrics exist. Set queriesOk accordingly.\n" +
    "2. If the framework supports local rendering, render the dashboard and screenshot it. " +
    "Otherwise validate the file against its schema/linter. Set rendered accordingly.\n" +
    "3. List concrete issues (empty if clean).",
  { label: "verify", schema: VERIFY_SCHEMA },
);
const issues = verify ? verify.issues : [];
log(
  "Verify: queries " +
    (verify && verify.queriesOk ? "OK" : "FAIL") +
    ", rendered " +
    (verify && verify.rendered ? "yes" : "no") +
    ", " +
    issues.length +
    " issues",
);

let fixNotes = "(clean)";
if (issues.length > 0) {
  const fixed = await agent(
    "Fix these dashboard issues:\n" +
      issues.map((i, n) => n + 1 + ". " + i).join("\n") +
      "\n\nFiles: " +
      impl.filesChanged.join(", "),
    { label: "verify:fix", phase: "Verify", schema: IMPL_SCHEMA },
  );
  fixNotes = fixed ? fixed.notes : "(fix skipped)";
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Open a PR for this dashboard.\n\n" +
    "## Request\n" +
    TASK +
    "\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n" +
    (verify && verify.screenshotPath ? "Screenshot: " + verify.screenshotPath + "\n" : "") +
    "\n" +
    "## Instructions\n" +
    "1. Run any repo lint/format on the dashboard files.\n" +
    "2. Commit, push, open a PR. Include the panel list and screenshot (if any) in the body.\n" +
    "3. Return PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Dashboard at " + disc.targetPath,
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  framework: disc.framework,
  targetPath: disc.targetPath,
  panels: design.panels.map((p) => p.name),
  filesChanged: impl.filesChanged,
  verify: verify
    ? {
        queriesOk: verify.queriesOk,
        rendered: verify.rendered,
        screenshot: verify.screenshotPath || null,
      }
    : null,
  fixNotes,
};
