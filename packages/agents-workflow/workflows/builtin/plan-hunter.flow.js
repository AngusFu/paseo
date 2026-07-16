/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "plan-hunter",
  description:
    "Exhaustive planning harness. Generates 4 independent draft plans (MVP-first, risk-first, dependency-first, user-first), scores them with 4 parallel judges, picks the winner by vote, then synthesizes a polished final plan grafting in the best ideas from runners-up.",
  whenToUse:
    "When the user has an idea they want planned thoroughly. BEFORE invoking this workflow, ask 2-3 clarifying questions if the idea is underspecified: (1) scope/timeline, (2) hard constraints or non-goals, (3) success criteria. Then pass the clarified idea as the args string.",
  phases: [
    { title: "Scope", detail: "Understand the idea, extract constraints, note assumptions" },
    { title: "Draft", detail: "4 parallel planners: MVP / Risk / Dependency / User lenses" },
    { title: "Judge", detail: "4 parallel judges rank all 4 drafts" },
    { title: "Synthesize", detail: "Polish the winner, graft best ideas from runners-up" },
  ],
};

// ═══ Lenses ═══
const LENSES = [
  {
    key: "mvp",
    label: "MVP-first",
    focus:
      "What is the smallest thing that ships and delivers value? Phase the plan so each phase is independently shippable. Defer everything non-essential.",
  },
  {
    key: "risk",
    label: "Risk-first",
    focus:
      "What could go wrong? Identify the riskiest assumptions and unknowns. Structure the plan to de-risk early — spike the hard parts before committing.",
  },
  {
    key: "dep",
    label: "Dependency-first",
    focus:
      "What must exist before what? Build a dependency graph. Sequence work so nothing blocks on something not yet built. Surface hidden dependencies.",
  },
  {
    key: "user",
    label: "User-first",
    focus:
      "What does the end user actually need? Work backward from the user journey. Every task should trace to a user-visible outcome.",
  },
];

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["idea", "constraints", "goals", "assumptions", "openQuestions"],
  properties: {
    idea: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};
const DRAFT_SCHEMA = {
  type: "object",
  required: ["plan", "risks", "gaps"],
  properties: {
    plan: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
};
const JUDGE_SCHEMA = {
  type: "object",
  required: ["rankings"],
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        required: ["lens", "score", "rationale"],
        properties: {
          lens: { type: "string" },
          score: { type: "number" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const IDEA =
  typeof args === "string" && args.trim()
    ? args.trim()
    : typeof args === "object" && args && typeof args.task === "string" && args.task.trim()
      ? args.task.trim()
      : typeof args === "object" && args && typeof args.prompt === "string" && args.prompt.trim()
        ? args.prompt.trim()
        : "";
if (!IDEA) {
  return { error: "No idea provided. Pass the idea as the args parameter." };
}

const scope = await agent(
  "Understand this idea and extract structure for planning.\n\n" +
    "## Idea\n" +
    IDEA +
    "\n\n" +
    "## Task\n" +
    "1. Restate the idea clearly (normalize vague wording).\n" +
    "2. Extract explicit constraints mentioned. If none, leave empty.\n" +
    "3. Extract goals/success criteria. If implicit, infer reasonable ones.\n" +
    "4. Note assumptions you are making to fill gaps.\n" +
    "5. List open questions the user should answer for a tighter plan.\n\n" +
    "Keep everything concise. Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { error: "Scope skipped." };

log(
  "Idea scoped: " +
    scope.goals.length +
    " goals, " +
    scope.constraints.length +
    " constraints, " +
    scope.assumptions.length +
    " assumptions",
);

// Shared context block for all planners and judges.
const CONTEXT =
  "## Idea\n" +
  scope.idea +
  "\n\n" +
  "## Goals\n" +
  scope.goals.map((g) => "- " + g).join("\n") +
  "\n\n" +
  "## Constraints\n" +
  (scope.constraints.length ? scope.constraints.map((c) => "- " + c).join("\n") : "(none stated)") +
  "\n\n" +
  "## Assumptions (made by scope)\n" +
  (scope.assumptions.length ? scope.assumptions.map((a) => "- " + a).join("\n") : "(none)") +
  "\n\n";

// ═══ Phase 1: Draft — 4 parallel planners ═══
phase("Draft");

const drafts = await parallel(
  LENSES.map(
    (lens) => () =>
      agent(
        CONTEXT +
          "## Your lens: " +
          lens.label +
          "\n" +
          lens.focus +
          "\n\n" +
          "## Task\n" +
          "Write a complete implementation plan from the " +
          lens.label +
          " perspective.\n" +
          "- Use numbered phases/steps.\n" +
          "- Be concrete: file paths, commands, decisions to make.\n" +
          "- List risks: things that could derail this plan.\n" +
          "- List gaps: things this plan doesn't address.\n\n" +
          "Structured output only.",
        { label: "draft:" + lens.key, phase: "Draft", schema: DRAFT_SCHEMA },
      ).then((d) => (d ? { lens: lens.key, label: lens.label, ...d } : null)),
  ),
);

const validDrafts = drafts.filter(Boolean);
if (validDrafts.length === 0) {
  return { error: "All drafts skipped.", scope };
}
log(validDrafts.length + " drafts ready");

// ═══ Phase 2: Judge — 4 parallel judges rank all drafts ═══
phase("Judge");

const draftsBlock = validDrafts
  .map(
    (d) =>
      "### " +
      d.label +
      " (key: " +
      d.lens +
      ")\n" +
      d.plan +
      "\n\n" +
      "Risks: " +
      d.risks.join("; ") +
      "\n" +
      "Gaps: " +
      d.gaps.join("; "),
  )
  .join("\n\n---\n\n");

const JUDGE_PROMPT =
  CONTEXT +
  "## Your task: rank these " +
  validDrafts.length +
  " plans\n\n" +
  draftsBlock +
  "\n\n" +
  "## Scoring\n" +
  "Score each plan 1-10 on overall quality for THIS idea. Consider:\n" +
  "- Completeness (does it cover the goals?)\n" +
  "- Practicality (can this actually be executed?)\n" +
  "- Risk awareness (are the risks real and addressed?)\n" +
  "- Sequencing (does the order make sense?)\n\n" +
  "Return rankings for ALL plans. Use the 'lens' key exactly as shown.\n" +
  "Structured output only.";

const judges = await parallel(
  [0, 1, 2, 3].map(
    (i) => () =>
      agent(JUDGE_PROMPT, {
        label: "judge-" + i,
        phase: "Judge",
        schema: JUDGE_SCHEMA,
      }),
  ),
);

const validJudges = judges.filter(Boolean);

// ═══ JS: aggregate scores ═══
const scores = {};
validDrafts.forEach((d) => {
  scores[d.lens] = { total: 0, votes: 0, rationales: [] };
});

validJudges.forEach((j) => {
  j.rankings.forEach((r) => {
    if (scores[r.lens]) {
      scores[r.lens].total += r.score;
      scores[r.lens].votes += 1;
      scores[r.lens].rationales.push(r.rationale);
    }
  });
});

const ranked = validDrafts
  .map((d) => ({
    ...d,
    avgScore: scores[d.lens].votes > 0 ? scores[d.lens].total / scores[d.lens].votes : 0,
  }))
  .sort((a, b) => b.avgScore - a.avgScore);

const winner = ranked[0];
const runnersUp = ranked.slice(1);

log("Winner: " + winner.label + " (avg " + winner.avgScore.toFixed(1) + "/10)");

// ═══ Phase 3: Synthesize — polish winner, graft best from runners-up ═══
phase("Synthesize");

const final = await agent(
  CONTEXT +
    "## Winning plan: " +
    winner.label +
    " (avg score " +
    winner.avgScore.toFixed(1) +
    "/10 across " +
    validJudges.length +
    " judges)\n\n" +
    winner.plan +
    "\n\n" +
    "## Judge rationales\n" +
    scores[winner.lens].rationales.map((r) => "- " + r).join("\n") +
    "\n\n" +
    "## Other plans (for grafting good ideas)\n" +
    runnersUp
      .map((d) => "### " + d.label + " (" + d.avgScore.toFixed(1) + "/10)\n" + d.plan)
      .join("\n\n") +
    "\n\n" +
    "## Task\n" +
    "Produce the FINAL plan.\n" +
    "1. Start from the winning plan's structure.\n" +
    "2. Graft in any clearly-better ideas from the runners-up.\n" +
    "3. Incorporate the risks/gaps all plans surfaced.\n" +
    "4. Open with any assumptions and open questions from scope — the user should confirm these.\n\n" +
    "Write it as a document the user can act on immediately. No preamble.",
  { label: "synthesize" },
);

return {
  plan: final,
  winner: { lens: winner.lens, label: winner.label, score: winner.avgScore },
  scoreboard: ranked.map((d) => ({ lens: d.lens, label: d.label, avgScore: d.avgScore })),
  scope: {
    idea: scope.idea,
    assumptions: scope.assumptions,
    openQuestions: scope.openQuestions,
  },
  stats: {
    drafts: validDrafts.length,
    judges: validJudges.length,
    agentCalls: 1 + validDrafts.length + validJudges.length + 1,
  },
};
