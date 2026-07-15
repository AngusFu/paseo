/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "bughunt-lite",
  description:
    "Lighter bug sweep — fixed 3-rapid+2-deep finders stream into 5-vote adversarial verification (pigeonhole early-exit), then synthesis. Simpler than bughunt: no self-respawning, no dry-streak.",
  whenToUse:
    "When the user wants a faster, bounded bug sweep of the current branch. Prefer over bughunt for small-to-medium diffs where a fixed finder pool is sufficient.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + 2 deep finders — stream into verify as each completes" },
    { title: "Verify", detail: "5 adversarial votes, pigeonhole early-exit (2 refute → skip 3)" },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};

// ═══ Constants ═══
const VOTES_PER_BUG = 5;
const REFUTATIONS_REQUIRED = 2;
const MAX_VERIFY = 20;

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffBase", "files", "summary"],
  properties: {
    diffBase: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          category: {
            enum: [
              "logic",
              "security",
              "performance",
              "convention",
              "correctness",
              "resource-leak",
              "race",
              "other",
            ],
          },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    severity: { enum: ["critical", "high", "medium", "low", "nit"] },
  },
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
        required: ["file", "title", "description", "severity", "vote", "evidence"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          vote: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const scope = await agent(
  "Discover the scope of changes on the current branch for a bug hunt.\n\n" +
    "1. Diff base: 'git rev-parse origin/main', fallback to 'main'.\n" +
    "2. Changed files: 'git diff --name-only <diffBase>...HEAD'\n" +
    "3. Summarize what changed in one paragraph.\n" +
    "4. Find CLAUDE.md files (root + parent dirs of changed files), extract relevant conventions.\n\n" +
    "Return ONLY structured output.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { summary: "Scope skipped.", bugs: [], stats: {} };
if (scope.files.length === 0)
  return { summary: "No changes on branch vs " + scope.diffBase + ".", bugs: [], stats: {} };

log(scope.files.length + " files changed vs " + scope.diffBase);

const SCOPE_BLOCK =
  "## Scope\nDiff base: " +
  scope.diffBase +
  "\n" +
  "Changed files (" +
  scope.files.length +
  "):\n" +
  scope.files.map((f) => "  - " + f).join("\n") +
  "\n\n" +
  "## What changed\n" +
  scope.summary +
  "\n\n" +
  "## Conventions (CLAUDE.md)\n" +
  (scope.conventions || "(none)") +
  "\n";

// ═══ Prompt builders ═══
const RAPID_PROMPT = (idx) =>
  "## Rapid Surface Scanner (" +
  (idx + 1) +
  "/3)\n\n" +
  "Quickly scan the change set. Report obvious issues. Do NOT deep-dive.\n\n" +
  SCOPE_BLOCK +
  "\n" +
  "## Look for\n**P1 CLAUDE.md violations** · **P2 Logic errors** (copy-paste, wrong conditions, null derefs) · **P3 Resource** (unbounded growth, missing await)\n\n" +
  "## Instructions\n1. Run 'git diff " +
  scope.diffBase +
  "...HEAD'\n2. Read changed files as needed\n" +
  "3. Report 5-12 bugs. Breadth > depth. OK to be wrong.\n" +
  "4. Bias toward " +
  ["first third", "middle third", "last third"][idx] +
  " of files.\n\nStructured output only.";

const DEEP_PROMPT = (idx) =>
  "## Deep Analyst (" +
  (idx + 1) +
  "/2)\n\n" +
  "Find subtle bugs requiring deep analysis.\n\n" +
  SCOPE_BLOCK +
  "\n" +
  "## Process\nRun 'git diff " +
  scope.diffBase +
  "...HEAD' · Read full files · Grep callers of modified functions · Trace callees · Trace data flow\n\n" +
  "## Look for\nInvariant violations · Races · State mutation · Edge cases (empty/null/concurrent)\n\n" +
  "Pick " +
  (idx === 0 ? "the most significant change" : "a DIFFERENT subsystem") +
  ". Go DEEP. 1-3 findings.\n\nStructured output only.";

const VERIFY_PROMPT = (bug, v) =>
  "## Adversarial Verifier (voter " +
  (v + 1) +
  "/" +
  VOTES_PER_BUG +
  ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug. " +
  "≥" +
  REFUTATIONS_REQUIRED +
  " refutations of " +
  VOTES_PER_BUG +
  " kill it.\n\n" +
  "## Candidate\nFile: " +
  bug.file +
  (bug.line != null ? ":" + bug.line : "") +
  "\n" +
  "Title: " +
  bug.title +
  "\nSeverity: " +
  bug.severity +
  "\nDescription: " +
  bug.description +
  "\n\n" +
  "## Checklist\n" +
  "1. Run 'git diff " +
  scope.diffBase +
  "...HEAD -- " +
  bug.file +
  "' and read the file — does the issue exist?\n" +
  "2. Check callers — reachable? Preconditions guaranteed?\n" +
  "3. Check handling — validation/error handling elsewhere?\n" +
  "4. Conventions — intentional per CLAUDE.md (above)?\n" +
  "5. Git history — pre-existing ≠ new bug. Already fixed/reverted?\n\n" +
  "**refuted=true** if: not reachable / handled / intentional / pre-existing / wrong.\n" +
  "**refuted=false** ONLY if: real, reachable, new, material.\n" +
  "Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST cite file:line.";

// ═══ Naive dedup state (accumulates across finders as they complete) ═══
const dedupKey = (b) => b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const seen = new Map();
const naiveDupes = [];
const budgetDropped = [];
let verifySlots = MAX_VERIFY;

// ═══ Pigeonhole verification: 2 votes first; if both refute, skip 3 ═══
function verifyBug(bug, finderName) {
  const shortName = bug.file.split("/").pop();
  const vote = (v) => () =>
    agent(VERIFY_PROMPT(bug, v), {
      label: "v" + v + ":" + shortName,
      phase: "Verify",
      schema: VERDICT_SCHEMA,
    });
  return parallel([0, 1].map(vote)).then((first2) => {
    const r2 = first2.filter(Boolean).filter((v) => v.refuted).length;
    if (r2 >= REFUTATIONS_REQUIRED) {
      log(shortName + ' "' + bug.title + '": 0-' + r2 + " ✗ (early kill)");
      return { ...bug, finder: finderName, verdicts: first2, refutedVotes: r2, survives: false };
    }
    return parallel([2, 3, 4].map(vote)).then((rest) => {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter((v) => v.refuted).length;
      const survives = r < REFUTATIONS_REQUIRED;
      log(
        shortName +
          ' "' +
          bug.title +
          '": ' +
          (all.length - r) +
          "-" +
          r +
          " " +
          (survives ? "✓" : "✗"),
      );
      return { ...bug, finder: finderName, verdicts: all, refutedVotes: r, survives };
    });
  });
}

// ═══ Pipeline: find → naive-dedup → pigeonhole-verify (no barrier) ═══
const FINDERS = [
  { type: "rapid", idx: 0 },
  { type: "rapid", idx: 1 },
  { type: "rapid", idx: 2 },
  { type: "deep", idx: 0 },
  { type: "deep", idx: 1 },
];

const results = await pipeline(
  FINDERS,

  (f) =>
    agent(f.type === "rapid" ? RAPID_PROMPT(f.idx) : DEEP_PROMPT(f.idx), {
      label: f.type + "-" + f.idx,
      phase: "Find",
      schema: BUGS_SCHEMA,
    }).then((r) => {
      if (!r) return { finder: f.type + "-" + f.idx, bugs: [] };
      log(f.type + "-" + f.idx + ": " + r.bugs.length + " raw");
      return { finder: f.type + "-" + f.idx, bugs: r.bugs };
    }),

  (findResult) => {
    // Sort by severity so high-priority bugs claim budget slots first
    const sorted = findResult.bugs
      .slice()
      .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    const novel = sorted.filter((b) => {
      const key = dedupKey(b);
      if (seen.has(key)) {
        naiveDupes.push({ ...b, finder: findResult.finder, dupOf: seen.get(key) });
        return false;
      }
      if (verifySlots <= 0 && sevRank[b.severity] >= 2) {
        budgetDropped.push({ ...b, finder: findResult.finder });
        return false;
      }
      seen.set(key, { finder: findResult.finder, title: b.title });
      verifySlots--;
      return true;
    });
    if (novel.length < findResult.bugs.length) {
      log(
        findResult.finder +
          ": " +
          novel.length +
          " novel (" +
          (findResult.bugs.length - novel.length) +
          " filtered)",
      );
    }
    return parallel(novel.map((bug) => () => verifyBug(bug, findResult.finder)));
  },
);

const allVoted = results.flat().filter(Boolean);
const confirmed = allVoted.filter((b) => b.survives);
const killed = allVoted.filter((b) => !b.survives);

log(
  "Pipeline done: " +
    allVoted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed · " +
    naiveDupes.length +
    " naive dupes · " +
    budgetDropped.length +
    " budget-dropped",
);

if (confirmed.length === 0) {
  return {
    summary:
      "Clean. " +
      allVoted.length +
      " voted, all killed. " +
      naiveDupes.length +
      " naive dupes filtered pre-verify.",
    bugs: [],
    killed: killed.map((b) => ({
      file: b.file,
      title: b.title,
      vote: b.verdicts.length - b.refutedVotes + "-" + b.refutedVotes,
    })),
    stats: {
      voted: allVoted.length,
      confirmed: 0,
      killed: killed.length,
      naiveDupes: naiveDupes.length,
      budgetDropped: budgetDropped.length,
    },
  };
}

// ═══ Phase 3: Synthesis ═══
phase("Synthesize");

const confRank = { high: 0, medium: 1, low: 2 };
const block = confirmed
  .map((b, i) => {
    const confirms = b.verdicts
      .filter(Boolean)
      .filter((v) => !v.refuted)
      .sort((a, b) => confRank[a.confidence] - confRank[b.confidence]);
    const best = confirms[0] || { evidence: "(no confirming verdict)", confidence: "low" };
    return (
      "### [" +
      i +
      "] " +
      b.title +
      " (" +
      b.severity +
      ", " +
      b.finder +
      ")\n" +
      "Vote: " +
      (b.verdicts.length - b.refutedVotes) +
      "-" +
      b.refutedVotes +
      " · File: " +
      b.file +
      (b.line != null ? ":" + b.line : "") +
      "\n" +
      b.description +
      "\nEvidence (" +
      best.confidence +
      "): " +
      best.evidence +
      "\n"
    );
  })
  .join("\n");

const report = await agent(
  "## Synthesis: semantic dedup + final report\n\n" +
    confirmed.length +
    " bugs survived adversarial verification. " +
    "Semantic duplicates are likely (naive dedup only caught file:line matches).\n\n" +
    block +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.\n" +
    "2. Order by severity: critical → high → medium → low → nit\n" +
    "3. Tighten titles/descriptions. Best evidence per bug.\n" +
    "4. 2-3 sentence summary.\n\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

const reportResult = report || { summary: "(synthesis skipped)", bugs: [] };

return {
  summary: reportResult.summary,
  bugs: reportResult.bugs,
  killed: killed.map((b) => ({
    file: b.file,
    title: b.title,
    vote: b.verdicts.length - b.refutedVotes + "-" + b.refutedVotes,
  })),
  stats: {
    voted: allVoted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSemanticDedup: reportResult.bugs.length,
    naiveDupes: naiveDupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + FINDERS.length + allVoted.reduce((s, b) => s + b.verdicts.length, 0) + 1,
  },
};
