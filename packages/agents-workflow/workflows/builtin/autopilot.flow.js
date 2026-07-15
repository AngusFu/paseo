/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "autopilot",
  description:
    "An end-to-end task runner. Builds a plan with a 5-angle adversarial critique, adjusts the plan, implements, uses a bughunt-lite review + feature completeness check, fixes issues, then opens a PR.",
  whenToUse:
    "When the user gives a self-contained coding task they want completed end-to-end without supervision. Best for long-running tasks that require some or large amounts of planning and verification. This workflow scopes the problem, hardens its plan using 5 critics, implements it, runs a bug hunting sweep and a feature completeness check, fixes issues, and then opens a PR.",
  phases: [
    {
      title: "Plan",
      detail: "Scope + draft, 5 critics (scope/simplicity/reuse/verification/correctness), harden",
    },
    { title: "Implement", detail: "Single agent executes the hardened plan" },
    {
      title: "Review",
      detail: "3 rapid + 2 deep finders, 5-vote pigeonhole verify, + completeness vs task",
    },
    { title: "Fix", detail: "Address confirmed issues (skipped if clean)" },
    { title: "PR", detail: "Lint, typecheck, open PR, subscribe to auto-fix" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No task provided. Pass the task description as args." };

// ═══ Schemas ═══
const PLAN_SCHEMA = {
  type: "object",
  required: ["summary", "files", "steps", "risks"],
  properties: {
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    reuse: {
      type: "array",
      items: { type: "string" },
      description: "Existing utilities/functions to reuse (file:line)",
    },
    verification: { type: "string" },
  },
};
const CRITIQUE_SCHEMA = {
  type: "object",
  required: ["verdict", "holes"],
  properties: {
    verdict: { enum: ["PASS", "REVISE"] },
    holes: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "severity"],
        properties: {
          issue: { type: "string" },
          severity: { enum: ["blocker", "major", "minor"] },
          suggestion: { type: "string" },
        },
      },
    },
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
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" } },
};
const COMPLETENESS_SCHEMA = {
  type: "object",
  required: ["covered", "gaps"],
  properties: {
    covered: { type: "boolean" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        required: ["what", "where"],
        properties: { what: { type: "string" }, where: { type: "string" } },
      },
    },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string", description: "2-3 sentence summary of what changed and why" },
    lintPassed: { type: "boolean" },
    typecheckPassed: { type: "boolean" },
    autoFixSubscribed: { type: "boolean" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Plan ═══
phase("Plan");

const draft = await agent(
  "Scope this task against the codebase and draft an implementation plan.\n\n" +
    "## Task\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Explore — find relevant files, existing patterns, utilities to reuse. " +
    "Actively search for existing functions and utilities that can be reused; " +
    "avoid proposing new code when suitable implementations already exist.\n" +
    "2. Read CLAUDE.md at project root and in parent dirs of relevant files.\n" +
    "3. Draft a concrete plan: files to touch, what edits, in what order.\n" +
    "4. Call out existing code to reuse with file:line.\n" +
    "5. List risks and describe verification (test command, manual check).\n\n" +
    "Be concrete — file paths and function names, not vague intentions.",
  { label: "plan:draft", schema: PLAN_SCHEMA },
);
if (!draft) return { error: "Plan draft skipped." };
log("Draft: " + draft.files.length + " files, " + draft.steps.length + " steps");

const PLAN_BLOCK =
  "## Task\n" +
  TASK +
  "\n\n" +
  "## Proposed plan\n" +
  draft.summary +
  "\n\n" +
  "**Files:** " +
  draft.files.join(", ") +
  "\n\n" +
  "**Steps:**\n" +
  draft.steps.map((s, i) => i + 1 + ". " + s).join("\n") +
  "\n\n" +
  "**Reuse:** " +
  (draft.reuse && draft.reuse.length ? draft.reuse.join("; ") : "(none listed)") +
  "\n\n" +
  "**Risks:** " +
  (draft.risks.length ? draft.risks.join("; ") : "(none)") +
  "\n\n" +
  "**Verification:** " +
  (draft.verification || "(not specified)") +
  "\n";

// Angle menu from autoPlan (cli#23382) plus a correctness angle.
// Consistency folded into reuse; security/performance/blast-radius left for
// a future conditional pass.
const CRITICS = [
  {
    key: "scope",
    lens: "Is the plan over- or under-scoped vs the ask? Does it do more than needed, or miss part of the request? Is this a spot fix where the underlying problem should be addressed more broadly, or the right-sized change?",
  },
  {
    key: "simplicity",
    lens: "Could this be simpler? Unnecessary abstractions, files that do not need touching, steps that could merge. What is the minimal diff?",
  },
  {
    key: "reuse",
    lens: "Does it call out existing code to reuse with file paths? Grep for similar utilities — is it reinventing something that exists? Does the approach match how neighboring code does similar things?",
  },
  {
    key: "verification",
    lens: "Are the test/verify steps concrete enough to catch a regression? Is there a runnable command, or is it hand-wavy?",
  },
  {
    key: "correctness",
    lens: "Will this plan actually solve the stated problem? Trace the logic — does the proposed change address the root cause? Grep for other code paths with the same pattern — are there sibling call sites that need the same fix?",
  },
];

const critiques = await parallel(
  CRITICS.map(
    (c) => () =>
      agent(
        PLAN_BLOCK +
          "\n## Your angle: " +
          c.key +
          "\n" +
          c.lens +
          "\n\n" +
          "## Instructions\n" +
          "Review this plan from the " +
          c.key +
          " angle ONLY. Other reviewers cover the rest.\n" +
          "Read the actual files it references. Verify claims against the codebase.\n" +
          "Verdict PASS if the plan is good enough to proceed from your angle.\n" +
          "Verdict REVISE with concrete holes otherwise — 'step 3 will not work because X', not 'might have issues'.\n" +
          "Severity: blocker = plan will fail; major = works but poorly; minor = nit.",
        { label: "plan:critic-" + c.key, phase: "Plan", schema: CRITIQUE_SCHEMA },
      ),
  ),
);

const holes = critiques.flatMap((c, i) =>
  c ? c.holes.map((h) => ({ ...h, critic: CRITICS[i].key })) : [],
);
const needsRevise = critiques.filter(Boolean).some((c) => c.verdict === "REVISE");
log(
  holes.length +
    " holes (" +
    holes.filter((h) => h.severity === "blocker").length +
    " blockers), " +
    (needsRevise ? "REVISE" : "PASS"),
);

const plan = !needsRevise
  ? draft
  : await agent(
      PLAN_BLOCK +
        "\n## Critique (" +
        holes.length +
        " holes from " +
        CRITICS.length +
        " critics)\n" +
        holes
          .map(
            (h) =>
              "- [" +
              h.severity +
              ", " +
              h.critic +
              "] " +
              h.issue +
              (h.suggestion ? " → " + h.suggestion : ""),
          )
          .join("\n") +
        "\n\n" +
        "## Instructions\n" +
        "Revise the plan. Blockers MUST be resolved. Majors addressed or explicitly acknowledged as tradeoffs. " +
        "Minors optional. Output the revised plan in the same schema.",
      { label: "plan:harden", phase: "Plan", schema: PLAN_SCHEMA },
    );
if (!plan) return { error: "Plan hardening skipped.", draft, holes };

// ═══ Phase 2: Implement ═══
phase("Implement");

const HARDENED_BLOCK =
  "## Task\n" +
  TASK +
  "\n\n" +
  "## Plan\n" +
  plan.summary +
  "\n\n" +
  "**Files:** " +
  plan.files.join(", ") +
  "\n\n" +
  "**Steps:**\n" +
  plan.steps.map((s, i) => i + 1 + ". " + s).join("\n") +
  "\n\n" +
  "**Reuse:** " +
  (plan.reuse && plan.reuse.length ? plan.reuse.join("; ") : "(none)") +
  "\n\n" +
  "**Risks:** " +
  (plan.risks.length ? plan.risks.join("; ") : "(none)") +
  "\n\n" +
  "**Verification:** " +
  (plan.verification || "(not specified)") +
  "\n";

const impl = await agent(
  HARDENED_BLOCK +
    "\n## Instructions\n" +
    "Execute this plan. Make the edits. Run the verification step.\n" +
    "Adapt if you hit something the plan missed — but note it.\n" +
    "Return done=false with blockers if you cannot proceed.",
  { label: "implement", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Implementation incomplete.",
    plan,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Implemented: " + impl.filesChanged.length + " files changed");

// ═══ Phase 3: Review (bughunt-lite + completeness) ═══
phase("Review");

const VOTES = 5;
const REFUTE_KILL = 2;
const MAX_VERIFY = 20;
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const dedupKey = (b) => b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");

const DIFF_INSTR =
  "Run 'git diff $(git merge-base HEAD origin/main)' to see all changes (committed + uncommitted). If origin/main doesn't exist, try 'main' or 'origin/HEAD'.";

const RAPID = (i) =>
  "## Rapid scanner " +
  (i + 1) +
  "/3\n" +
  DIFF_INSTR +
  "\n\n" +
  "Quick surface scan. Report 5-10 obvious issues: logic errors, null derefs, " +
  "CLAUDE.md violations, missing awaits. Breadth over depth. " +
  "Bias toward the " +
  ["first", "middle", "last"][i] +
  " third of the diff.\nStructured output only.";

const DEEP = (i) =>
  "## Deep analyst " +
  (i + 1) +
  "/2\n" +
  DIFF_INSTR +
  "\n\n" +
  "Find subtle issues. Read full files, grep callers, trace data flow. " +
  "Invariant violations, races, edge cases (empty/null/concurrent). " +
  "Pick " +
  (i === 0 ? "the most significant change" : "a DIFFERENT area") +
  ". 1-3 findings.\nStructured output only.";

const VERIFY = (b, v) =>
  "## Adversarial verifier " +
  (v + 1) +
  "/" +
  VOTES +
  "\n" +
  "Be SKEPTICAL. Try to REFUTE. ≥" +
  REFUTE_KILL +
  " refutes kill it.\n\n" +
  "**Candidate:** " +
  b.file +
  (b.line != null ? ":" + b.line : "") +
  " — " +
  b.title +
  "\n" +
  b.description +
  "\n\n" +
  DIFF_INSTR +
  " Read the file. Check callers, error handling, conventions.\n" +
  "refuted=true if: unreachable, handled, intentional, pre-existing, wrong.\n" +
  "refuted=false ONLY if real, new, material. Default refuted=true when uncertain.\n" +
  "Evidence must cite file:line.";

const seen = new Map();
let slots = MAX_VERIFY;

function verifyBug(b) {
  const short = b.file.split("/").pop();
  const vote = (v) => () =>
    agent(VERIFY(b, v), { label: "v" + v + ":" + short, phase: "Review", schema: VERDICT_SCHEMA });
  return parallel([0, 1].map(vote)).then((first2) => {
    const r2 = first2.filter(Boolean).filter((v) => v.refuted).length;
    if (r2 >= REFUTE_KILL) return { ...b, votes: first2, refuted: r2, survives: false };
    return parallel([2, 3, 4].map(vote)).then((rest) => {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter((v) => v.refuted).length;
      return { ...b, votes: all, refuted: r, survives: r < REFUTE_KILL };
    });
  });
}

const FINDERS = [
  { kind: "rapid", i: 0 },
  { kind: "rapid", i: 1 },
  { kind: "rapid", i: 2 },
  { kind: "deep", i: 0 },
  { kind: "deep", i: 1 },
];

// Completeness check runs in parallel with the bughunt pipeline — it's
// independent of diff-local findings.
const [bugResults, completeness] = await Promise.all([
  pipeline(
    FINDERS,
    (f) =>
      agent(f.kind === "rapid" ? RAPID(f.i) : DEEP(f.i), {
        label: f.kind + "-" + f.i,
        phase: "Review",
        schema: BUGS_SCHEMA,
      }),
    (r) => {
      if (!r) return [];
      const sorted = r.bugs.slice().sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
      const novel = sorted.filter((b) => {
        const k = dedupKey(b);
        if (seen.has(k)) return false;
        if (slots <= 0 && sevRank[b.severity] >= 2) return false;
        seen.set(k, true);
        slots--;
        return true;
      });
      return parallel(novel.map((b) => () => verifyBug(b)));
    },
  ),
  agent(
    "## Completeness check\n\n" +
      "## Original task\n" +
      TASK +
      "\n\n" +
      "## Plan that was executed\n" +
      plan.summary +
      "\n" +
      "Files planned: " +
      plan.files.join(", ") +
      "\n\n" +
      "## Instructions\n" +
      DIFF_INSTR +
      "\n" +
      "Compare the diff against the task. Did the implementation cover everything?\n" +
      "Look for: callers that should have been updated, tests that should exist, " +
      "docs/types that should have changed, parts of the ask that were missed.\n" +
      "covered=true if the task is fully addressed. Otherwise list concrete gaps with file paths.",
    { label: "review:completeness", phase: "Review", schema: COMPLETENESS_SCHEMA },
  ),
]);

const voted = bugResults.flat().filter(Boolean);
const confirmed = voted.filter((b) => b.survives);
const gaps = completeness && !completeness.covered ? completeness.gaps : [];
log(
  "Review: " +
    voted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    gaps.length +
    " completeness gaps",
);

// ═══ Phase 4: Fix ═══
let fixNotes = "(clean — no fixes needed)";
if (confirmed.length > 0 || gaps.length > 0) {
  phase("Fix");
  const bugBlock = confirmed
    .map(
      (b, i) =>
        i +
        1 +
        ". [" +
        b.severity +
        "] " +
        b.file +
        (b.line != null ? ":" + b.line : "") +
        " — " +
        b.title +
        "\n   " +
        b.description,
    )
    .join("\n");
  const gapBlock = gaps.map((g, i) => i + 1 + ". " + g.what + " (at " + g.where + ")").join("\n");
  const fixResult = await agent(
    "Address confirmed review findings.\n\n" +
      (confirmed.length
        ? "## Bugs (" + confirmed.length + ", survived adversarial verify)\n" + bugBlock + "\n\n"
        : "") +
      (gaps.length ? "## Completeness gaps (" + gaps.length + ")\n" + gapBlock + "\n\n" : "") +
      "## Instructions\n" +
      "Fix each item. If one turns out to be a false positive, note why and skip. " +
      "Summarize what you changed.",
    { label: "fix", schema: IMPL_SCHEMA },
  );
  fixNotes = !fixResult
    ? "(fix skipped)"
    : !fixResult.done
      ? "INCOMPLETE — " + (fixResult.blockers || []).join("; ") + ". " + fixResult.notes
      : fixResult.notes;
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Finalize and open a PR.\n\n" +
    "## Task\n" +
    TASK +
    "\n\n## What was done\n" +
    plan.summary +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint and typecheck. Fix any failures.\n" +
    "2. If on main, create a kebab-case branch from the task.\n" +
    "3. Commit with a clear message. Push. Open a PR (use template if present). Assign reviewers based on CODEOWNERS or recent git blame against the base branch for the touched files.\n" +
    "4. After the PR/MR is created, enable auto-fix by using available " +
    "repository automation tools (e.g., gh, glab, or MCP equivalents) to " +
    "monitor for CI failures and review comments. Pass the repository " +
    "identifier and PR/MR number parsed from the URL. Set autoFixSubscribed=true " +
    "if that succeeds. If no such tools are available in this environment, skip " +
    "this step and set autoFixSubscribed=false.\n" +
    "5. Return the PR URL, branch name, autoFixSubscribed, and a 2-3 sentence summary of what changed and why.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. " + (impl.notes || plan.summary),
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  autoFixSubscribed: pr ? (pr.autoFixSubscribed ?? null) : null,
  plan: { summary: plan.summary, files: plan.files },
  critique: { holes: holes.length, blockers: holes.filter((h) => h.severity === "blocker").length },
  review: { voted: voted.length, confirmed: confirmed.length, gaps: gaps.length },
  fixNotes,
};
