/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "bugfix",
  description:
    "Reproduce-first bug fixer. Writes a failing repro, root-causes the fault, applies the minimal fix, converts the repro into a regression test, then opens a PR.",
  whenToUse:
    "When the user reports a specific bug to fix. Best when the bug is concrete enough to reproduce. This workflow writes a failing repro first, traces the root cause, applies the smallest fix that makes the repro pass, locks it in as a regression test, and opens a PR.",
  phases: [
    { title: "Reproduce", detail: "Write a failing script or test that demonstrates the bug" },
    { title: "Root-cause", detail: "Trace the fault, grep callers, identify the minimal culprit" },
    { title: "Fix", detail: "Smallest diff that makes the repro pass" },
    { title: "Regress", detail: "Convert repro into a permanent test, run the touched suite" },
    { title: "PR", detail: "Lint, typecheck, open PR" },
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
if (!TASK) return { error: "No bug description provided. Pass the bug report as args." };

// ═══ Schemas ═══
const REPRO_SCHEMA = {
  type: "object",
  required: ["reproduced", "reproPath", "expected", "actual", "notes"],
  properties: {
    reproduced: { type: "boolean" },
    reproPath: { type: "string", description: "Path to the failing test or repro script" },
    reproCommand: { type: "string", description: "Command that runs the repro and fails" },
    expected: { type: "string" },
    actual: { type: "string" },
    notes: { type: "string" },
  },
};
const ROOT_CAUSE_SCHEMA = {
  type: "object",
  required: ["rootCause", "culprit", "callers"],
  properties: {
    rootCause: { type: "string" },
    culprit: { type: "string", description: "file:line of the minimal fault" },
    callers: { type: "array", items: { type: "string" } },
    fixApproach: { type: "string" },
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
const REGRESS_SCHEMA = {
  type: "object",
  required: ["testPath", "testPassed", "suitePassed", "notes"],
  properties: {
    testPath: { type: "string" },
    testPassed: { type: "boolean" },
    suitePassed: { type: "boolean" },
    notes: { type: "string" },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    lintPassed: { type: "boolean" },
    typecheckPassed: { type: "boolean" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Reproduce ═══
phase("Reproduce");

const repro = await agent(
  "Reproduce this bug with a failing test or script.\n\n" +
    "## Bug report\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Read the relevant code and any linked traces/logs to understand the claimed behavior.\n" +
    "2. Write the SMALLEST failing test or standalone script that demonstrates the bug. " +
    "Prefer a test in the existing test framework; fall back to a script if no framework fits.\n" +
    "3. Run it. Confirm it FAILS with the expected vs actual mismatch.\n" +
    "4. If you cannot reproduce after a genuine attempt, set reproduced=false and explain why in notes.\n\n" +
    "Do NOT fix the bug yet — only reproduce it.",
  { label: "reproduce", schema: REPRO_SCHEMA },
);
if (!repro) return { error: "Reproduce step skipped." };
if (!repro.reproduced) {
  return {
    summary: "Could not reproduce the bug. " + repro.notes,
    reproduced: false,
    repro,
  };
}
log(
  "Reproduced: " + repro.reproPath + " (expected " + repro.expected + ", got " + repro.actual + ")",
);

const REPRO_BLOCK =
  "## Bug report\n" +
  TASK +
  "\n\n" +
  "## Repro\n" +
  "Path: " +
  repro.reproPath +
  "\n" +
  (repro.reproCommand ? "Command: " + repro.reproCommand + "\n" : "") +
  "Expected: " +
  repro.expected +
  "\n" +
  "Actual: " +
  repro.actual +
  "\n" +
  "Notes: " +
  repro.notes +
  "\n";

// ═══ Phase 2: Root-cause ═══
phase("Root-cause");

const rc = await agent(
  REPRO_BLOCK +
    "\n## Instructions\n" +
    "Find the ROOT cause — not the first place the symptom appears.\n" +
    "1. Trace backwards from the failure point. Read the code paths the repro exercises.\n" +
    "2. Grep for callers and sibling code paths that touch the same state — note any that share the fault.\n" +
    "3. Identify the minimal culprit (file:line). Distinguish the root cause from downstream symptoms.\n" +
    "4. Propose the smallest fix approach that addresses the root cause, not a patch over the symptom.",
  { label: "root-cause", schema: ROOT_CAUSE_SCHEMA },
);
if (!rc) return { error: "Root-cause step skipped.", repro };
log("Root cause: " + rc.culprit + " — " + rc.rootCause);

// ═══ Phase 3: Fix ═══
phase("Fix");

const fix = await agent(
  REPRO_BLOCK +
    "\n## Root cause\n" +
    rc.rootCause +
    "\n" +
    "Culprit: " +
    rc.culprit +
    "\n" +
    "Callers sharing the fault: " +
    (rc.callers.length ? rc.callers.join(", ") : "(none)") +
    "\n" +
    "Approach: " +
    (rc.fixApproach || "(not specified)") +
    "\n\n" +
    "## Instructions\n" +
    "Apply the minimal fix at the root cause. Update sibling callers if they share the fault.\n" +
    "Re-run the repro" +
    (repro.reproCommand ? " (" + repro.reproCommand + ")" : "") +
    " — it MUST now pass.\n" +
    "Return done=false with blockers if the repro still fails after your fix.",
  { label: "fix", schema: IMPL_SCHEMA },
);
if (!fix || !fix.done) {
  return {
    error: "Fix incomplete.",
    repro,
    rootCause: rc,
    blockers: fix ? fix.blockers : ["skipped"],
  };
}
log("Fixed: " + fix.filesChanged.length + " files changed");

// ═══ Phase 4: Regress ═══
phase("Regress");

const regress = await agent(
  REPRO_BLOCK +
    "\n## Fix applied\n" +
    fix.notes +
    "\n" +
    "Files changed: " +
    fix.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Convert the repro at " +
    repro.reproPath +
    " into a permanent regression test in the " +
    "right location for this codebase. If it is already a proper test, tighten the assertion " +
    "and naming so it clearly describes the bug it guards against.\n" +
    "2. Run the regression test — it must PASS.\n" +
    "3. Run the full test suite for the touched module(s) — flag any new failures.\n" +
    "Return testPassed and suitePassed honestly.",
  { label: "regress", schema: REGRESS_SCHEMA },
);
if (!regress) return { error: "Regression step skipped.", repro, rootCause: rc, fix };
log(
  "Regression test: " +
    regress.testPath +
    " (test " +
    (regress.testPassed ? "PASS" : "FAIL") +
    ", suite " +
    (regress.suitePassed ? "PASS" : "FAIL") +
    ")",
);

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Finalize and open a PR for this bug fix.\n\n" +
    "## Bug\n" +
    TASK +
    "\n\n" +
    "## Root cause\n" +
    rc.rootCause +
    " (at " +
    rc.culprit +
    ")\n\n" +
    "## Regression test\n" +
    regress.testPath +
    (regress.suitePassed
      ? ""
      : "\n\nNOTE: suite had failures — investigate before merging: " + regress.notes) +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint and typecheck. Fix any failures.\n" +
    "2. If on main, create a kebab-case branch from the bug.\n" +
    "3. Commit with a clear message referencing the symptom and root cause. Push. Open a PR. " +
    "Include the repro steps and regression test path in the PR body.\n" +
    "4. Return the PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Fix applied: " + fix.notes,
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  reproduced: true,
  rootCause: { summary: rc.rootCause, culprit: rc.culprit },
  regressionTest: regress.testPath,
  testPassed: regress.testPassed,
  suitePassed: regress.suitePassed,
};
