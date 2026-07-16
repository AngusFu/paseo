/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "investigate",
  description:
    "Root-cause investigation. Gathers evidence, generates competing hypotheses in parallel, adversarially refutes each one, and produces a written root-cause report with a suggested fix.",
  whenToUse:
    "When the user wants the root cause of an incident, error, log, trace, or puzzling behavior found — without necessarily fixing it. This workflow collects evidence, runs parallel hypothesis agents, tries to refute each hypothesis, and writes up the surviving root cause with next steps. It produces a report, not a PR.",
  phases: [
    { title: "Gather", detail: "Logs, traces, repro, timeline" },
    { title: "Hypothesize", detail: "3 parallel hypothesis agents" },
    { title: "Verify", detail: "One adversarial refuter per hypothesis" },
    { title: "Report", detail: "Root-cause writeup, suggested fix, next steps" },
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
if (!TASK)
  return {
    error: "No incident description provided. Pass the incident, error, or question as args.",
  };

const GATHER_SCHEMA = {
  type: "object",
  required: ["timeline", "evidence", "scope"],
  properties: {
    timeline: { type: "string", description: "What happened, in order" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: "Concrete observations with file:line or log refs",
    },
    scope: { type: "string", description: "What is affected and what is not" },
    reproSteps: { type: "string" },
  },
};
const HYPOTHESIS_SCHEMA = {
  type: "object",
  required: ["hypothesis", "mechanism", "predicts"],
  properties: {
    hypothesis: { type: "string", description: "One-sentence root cause claim" },
    mechanism: { type: "string", description: "How this cause produces the observed symptom" },
    predicts: {
      type: "array",
      items: { type: "string" },
      description: "Testable predictions if this is true",
    },
    suspectCode: { type: "string", description: "file:line if applicable" },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence"],
  properties: { refuted: { type: "boolean" }, evidence: { type: "string" } },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "rootCause", "suggestedFix", "nextSteps"],
  properties: {
    summary: { type: "string" },
    rootCause: { type: "string" },
    suggestedFix: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" } },
    confidence: { enum: ["high", "medium", "low"] },
  },
};

// ═══ Phase 1: Gather ═══
phase("Gather");

const gather = await agent(
  "Gather evidence for this investigation. Do NOT theorize yet — just collect facts.\n\n" +
    "## Incident\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Read any referenced logs, traces, error messages, or files. Pull out concrete " +
    "observations — quote exact lines with their source.\n" +
    "2. Establish a timeline: what happened first, what followed.\n" +
    "3. Establish scope: what is broken, what still works, when it started.\n" +
    "4. If reproducible, note the minimal repro steps.\n\n" +
    "Stick to observations. No conclusions.",
  { label: "gather", schema: GATHER_SCHEMA },
);
if (!gather) return { error: "Gather step skipped." };
log("Gathered " + gather.evidence.length + " pieces of evidence");

const EVIDENCE_BLOCK =
  "## Incident\n" +
  TASK +
  "\n\n" +
  "## Timeline\n" +
  gather.timeline +
  "\n\n" +
  "## Scope\n" +
  gather.scope +
  "\n\n" +
  "## Evidence\n" +
  gather.evidence.map((e, i) => i + 1 + ". " + e).join("\n") +
  "\n" +
  (gather.reproSteps ? "\n## Repro\n" + gather.reproSteps + "\n" : "");

// ═══ Phase 2: Hypothesize (3 parallel) ═══
phase("Hypothesize");

const ANGLES = [
  {
    key: "recent-change",
    lens: "Assume a recent code or config change caused this. Check git log, recent deploys, flag flips.",
  },
  {
    key: "data-edge-case",
    lens: "Assume the code is fine and a particular input, state, or environment value triggered a latent edge case.",
  },
  {
    key: "infra-timing",
    lens: "Assume a race, timeout, resource limit, dependency outage, or ordering issue — not the application logic itself.",
  },
];

const hypotheses = await parallel(
  ANGLES.map(
    (a) => () =>
      agent(
        EVIDENCE_BLOCK +
          "\n## Your angle: " +
          a.key +
          "\n" +
          a.lens +
          "\n\n" +
          "## Instructions\n" +
          "Propose ONE concrete root-cause hypothesis from this angle. Read the relevant code. " +
          "Explain the mechanism — how this cause produces EVERY observation in the evidence list. " +
          "List 2-3 testable predictions: things that would be true if and only if this hypothesis holds.",
        { label: "hypothesis:" + a.key, phase: "Hypothesize", schema: HYPOTHESIS_SCHEMA },
      ),
  ),
);
const hyps = hypotheses.map((h, i) => (h ? { ...h, angle: ANGLES[i].key } : null)).filter(Boolean);
if (hyps.length === 0) return { error: "No hypotheses generated.", gather };
log(hyps.length + " hypotheses: " + hyps.map((h) => h.angle).join(", "));

// ═══ Phase 3: Verify (adversarial refutation) ═══
phase("Verify");

const verdicts = await parallel(
  hyps.map(
    (h) => () =>
      agent(
        EVIDENCE_BLOCK +
          "\n## Hypothesis under test (" +
          h.angle +
          ")\n" +
          h.hypothesis +
          "\n\nMechanism: " +
          h.mechanism +
          "\n" +
          "Predictions: " +
          h.predicts.join("; ") +
          "\n" +
          (h.suspectCode ? "Suspect: " + h.suspectCode + "\n" : "") +
          "\n" +
          "## Instructions\n" +
          "Try to REFUTE this hypothesis. Check each prediction against the codebase and evidence. " +
          "Look for evidence the hypothesis CANNOT explain.\n" +
          "refuted=true if any prediction fails or any evidence contradicts the mechanism.\n" +
          "refuted=false ONLY if every prediction checks out and nothing contradicts it.\n" +
          "Evidence must cite file:line or a specific observation number.",
        { label: "refute:" + h.angle, phase: "Verify", schema: VERDICT_SCHEMA },
      ).then((v) => ({ ...h, verdict: v })),
  ),
);

const survived = verdicts.filter((v) => v && v.verdict && !v.verdict.refuted);
const refuted = verdicts.filter((v) => v && v.verdict && v.verdict.refuted);
log("Verify: " + survived.length + " survived, " + refuted.length + " refuted");

// ═══ Phase 4: Report ═══
phase("Report");

const survivedBlock =
  survived.length > 0
    ? survived
        .map(
          (h) =>
            "### " +
            h.hypothesis +
            " (" +
            h.angle +
            ")\n" +
            "Mechanism: " +
            h.mechanism +
            "\n" +
            (h.suspectCode ? "Suspect: " + h.suspectCode + "\n" : "") +
            "Verifier evidence: " +
            h.verdict.evidence +
            "\n",
        )
        .join("\n")
    : "(none survived — all hypotheses refuted)";

const refutedBlock = refuted
  .map((h) => "- " + h.hypothesis + " (" + h.angle + ") — refuted: " + h.verdict.evidence)
  .join("\n");

const report = await agent(
  "Write the root-cause report.\n\n" +
    EVIDENCE_BLOCK +
    "\n" +
    "## Surviving hypotheses (" +
    survived.length +
    ")\n" +
    survivedBlock +
    "\n\n" +
    "## Refuted hypotheses (" +
    refuted.length +
    ")\n" +
    (refutedBlock || "(none)") +
    "\n\n" +
    "## Instructions\n" +
    (survived.length === 1
      ? "One hypothesis survived — that is the root cause. "
      : survived.length > 1
        ? "Multiple hypotheses survived — pick the one that best explains ALL evidence, or note they may compound. "
        : "No hypothesis survived — synthesize the most likely cause from what was learned during refutation, with low confidence. ") +
    "Write: a 2-3 sentence summary, the root cause, a concrete suggested fix (file:line where " +
    "possible), confidence level, and next steps (further verification, monitoring, follow-ups).",
  { label: "report", schema: REPORT_SCHEMA },
);
if (!report) return { error: "Report step skipped.", gather, survived, refuted };

return {
  summary: report.summary,
  rootCause: report.rootCause,
  suggestedFix: report.suggestedFix,
  confidence:
    report.confidence || (survived.length === 1 ? "high" : survived.length > 1 ? "medium" : "low"),
  nextSteps: report.nextSteps,
  hypotheses: {
    survived: survived.map((h) => ({
      angle: h.angle,
      hypothesis: h.hypothesis,
      suspect: h.suspectCode || null,
    })),
    refuted: refuted.map((h) => ({
      angle: h.angle,
      hypothesis: h.hypothesis,
      reason: h.verdict.evidence,
    })),
  },
  evidence: gather.evidence,
};
