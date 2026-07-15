// A self-contained bughunt-lite-style workflow used by the e2e test.
// Mirrors the real 2.1.150 bughunt-lite structure (Scope -> Find -> Verify ->
// Synthesize) but trimmed, so the test exercises the full pipeline shape,
// schemas, naive dedup, pigeonhole verification, and synthesis.
export const meta = {
  name: "bughunt-lite-mini",
  description:
    "Mini bug sweep: fixed finders stream into adversarial verification, then synthesis.",
  phases: [
    { title: "Scope", detail: "diff base + files" },
    { title: "Find", detail: "rapid + deep finders" },
    { title: "Verify", detail: "adversarial votes" },
    { title: "Synthesize", detail: "dedup + report" },
  ],
};

const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffBase", "files"],
  properties: { diffBase: { type: "string" }, files: { type: "array", items: { type: "string" } } },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" } },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "bugs"],
  properties: {
    summary: { type: "string" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" }, severity: { type: "string" } },
      },
    },
  },
};

phase("Scope");
const scope = await agent("Discover the scope of changes on the current branch.", {
  label: "scope",
  schema: SCOPE_SCHEMA,
});
if (!scope) return { summary: "scope failed", bugs: [] };
log("scope: " + scope.files.length + " files vs " + scope.diffBase);

const FINDERS = [
  { type: "rapid", idx: 0 },
  { type: "rapid", idx: 1 },
  { type: "deep", idx: 0 },
];
const dedupKey = (b) => b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");
const seen = new Map();

phase("Find");
// pipeline: find -> (dedup barrier) -> verify, no barrier between find and verify
const voted = await pipeline(
  FINDERS,
  (f) =>
    agent("Finder role " + f.type + "-" + f.idx + " on branch " + scope.diffBase, {
      label: f.type + "-" + f.idx,
      phase: "Find",
      schema: BUGS_SCHEMA,
    }),
  (res) => {
    const bugs = (res && res.bugs) || [];
    const novel = bugs.filter((b) => {
      const k = dedupKey(b);
      if (seen.has(k)) return false;
      seen.set(k, b.title);
      return true;
    });
    // 3 adversarial votes per novel bug; >=2 refutes kills
    return parallel(
      novel.map((bug) => async () => {
        const verdicts = await parallel(
          [0, 1, 2].map(
            (v) => () =>
              agent("Verify bug: " + bug.title, {
                label: "v" + v + ":" + bug.file,
                phase: "Verify",
                schema: VERDICT_SCHEMA,
              }),
          ),
        );
        const refutes = verdicts.filter(Boolean).filter((v) => v.refuted).length;
        return { bug, survives: refutes < 2, refutes };
      }),
    );
  },
);

const all = voted.flat().filter(Boolean);
const confirmed = all.filter((r) => r.survives);
log("voted: " + all.length + " -> confirmed " + confirmed.length);

phase("Synthesize");
const report = await agent(
  "Synthesize these confirmed bugs into a final report:\n" +
    confirmed
      .map((r, i) => "[" + i + "] " + r.bug.title + " (" + r.bug.severity + ") @ " + r.bug.file)
      .join("\n"),
  { label: "synthesize", schema: REPORT_SCHEMA },
);

return {
  summary: report ? report.summary : "(no report)",
  bugs: report ? report.bugs : [],
  stats: { finders: FINDERS.length, voted: all.length, confirmed: confirmed.length },
};
