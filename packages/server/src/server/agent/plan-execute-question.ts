/**
 * Synthetic plan-execute CTA after Cursor/ACP CreatePlan.
 * Rendered as kind:"question" so mobile/desktop share QuestionFormCard.
 */

export const PLAN_EXECUTE_QUESTION_ID_PREFIX = "plan-execute-question-";
export const PLAN_EXECUTE_QUESTION_HEADER = "Execute";
export const PLAN_EXECUTE_OPTION_LABEL = "Execute";
export const PLAN_EXECUTE_DISMISS_LABEL = "Not now";

const PLAN_IMPLEMENTATION_PROMPT_PREFIX =
  "The user approved the plan. Implement it now. Do not restate or revise the plan unless blocked.";

export function isPlanExecuteQuestionRequestId(requestId: string): boolean {
  return requestId.startsWith(PLAN_EXECUTE_QUESTION_ID_PREFIX);
}

export function buildPlanExecuteQuestionRequestId(suffix: string): string {
  return `${PLAN_EXECUTE_QUESTION_ID_PREFIX}${suffix}`;
}

export function buildPlanExecuteQuestions(): Array<{
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
  dismissLabel: string;
}> {
  return [
    {
      header: PLAN_EXECUTE_QUESTION_HEADER,
      question: "Start implementing this plan?",
      options: [
        {
          label: PLAN_EXECUTE_OPTION_LABEL,
          description: "Leave plan mode and implement the approved plan",
        },
      ],
      multiSelect: false,
      allowOther: false,
      dismissLabel: PLAN_EXECUTE_DISMISS_LABEL,
    },
  ];
}

export function isCreatePlanToolName(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const token = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return token === "createplan" || token.endsWith("createplan");
}

export function normalizePlanMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** Pull plan markdown from CreatePlan args/result-shaped records. */
export function extractPlanTextFromRecord(
  record: Record<string, unknown> | null | undefined,
): string | null {
  if (!record) {
    return null;
  }
  for (const key of ["plan", "content", "text", "overview", "markdown"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return normalizePlanMarkdown(value);
    }
  }
  const name = record.name;
  if (typeof name === "string" && name.trim()) {
    return normalizePlanMarkdown(name);
  }
  return null;
}

export function buildPlanImplementationPrompt(planText: string): string {
  const normalizedPlan = normalizePlanMarkdown(planText);
  if (!normalizedPlan) {
    return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX} Make the required code changes and verify them.`;
  }
  return [
    PLAN_IMPLEMENTATION_PROMPT_PREFIX,
    "Approved plan:",
    normalizedPlan,
    "Carry out the work, make the necessary code changes, and verify the result.",
  ].join("\n\n");
}

export function isPlanExecuteAnswer(answers: unknown): boolean {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return false;
  }
  const record = answers as Record<string, unknown>;
  const value = record[PLAN_EXECUTE_QUESTION_HEADER];
  if (typeof value !== "string") {
    return false;
  }
  const token = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return token === "execute" || token.includes("execute");
}

const DEFAULT_IMPLEMENTATION_MODE_PREFERENCE = ["default", "agent", "code", "acceptEdits"] as const;
/** cursor-print: prefer unattended modes when leaving plan/ask after Execute. */
export const CURSOR_PRINT_IMPLEMENTATION_MODE_PREFERENCE = [
  "auto-review",
  "force",
  "default",
  "agent",
] as const;

export function resolveImplementationModeId(
  availableModes: ReadonlyArray<{ id: string }>,
  preferred: readonly string[] = DEFAULT_IMPLEMENTATION_MODE_PREFERENCE,
): string {
  for (const id of preferred) {
    if (availableModes.some((mode) => mode.id === id)) {
      return id;
    }
  }
  const nonPlan = availableModes.find((mode) => mode.id !== "plan" && mode.id !== "ask");
  return nonPlan?.id ?? "default";
}
