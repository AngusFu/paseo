import { describe, expect, it } from "vitest";
import {
  buildPlanExecuteQuestionRequestId,
  buildPlanExecuteQuestions,
  buildPlanImplementationPrompt,
  isCreatePlanToolName,
  isPlanExecuteAnswer,
  isPlanExecuteQuestionRequestId,
  PLAN_EXECUTE_OPTION_LABEL,
  PLAN_EXECUTE_QUESTION_HEADER,
  resolveImplementationModeId,
} from "./plan-execute-question.js";

describe("plan-execute-question helpers", () => {
  it("identifies CreatePlan tool names across casing and separators", () => {
    expect(isCreatePlanToolName("CreatePlan")).toBe(true);
    expect(isCreatePlanToolName("create_plan")).toBe(true);
    expect(isCreatePlanToolName("create-plan")).toBe(true);
    expect(isCreatePlanToolName("MCP: CreatePlan")).toBe(true);
    expect(isCreatePlanToolName("AskUserQuestion")).toBe(false);
  });

  it("builds a single-choice execute question for QuestionFormCard", () => {
    const questions = buildPlanExecuteQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.header).toBe(PLAN_EXECUTE_QUESTION_HEADER);
    expect(questions[0]?.options.map((option) => option.label)).toEqual([
      PLAN_EXECUTE_OPTION_LABEL,
    ]);
    expect(questions[0]?.allowOther).toBe(false);
  });

  it("recognizes plan-execute request ids and execute answers", () => {
    const requestId = buildPlanExecuteQuestionRequestId("abc");
    expect(isPlanExecuteQuestionRequestId(requestId)).toBe(true);
    expect(isPlanExecuteQuestionRequestId("permission-abc")).toBe(false);
    expect(isPlanExecuteAnswer({ [PLAN_EXECUTE_QUESTION_HEADER]: "Execute" })).toBe(true);
    expect(isPlanExecuteAnswer({ [PLAN_EXECUTE_QUESTION_HEADER]: "Not now" })).toBe(false);
  });

  it("builds an implementation prompt that includes the approved plan", () => {
    const prompt = buildPlanImplementationPrompt("- Step one\n- Step two");
    expect(prompt).toContain("The user approved the plan");
    expect(prompt).toContain("- Step one");
    expect(prompt).toContain("- Step two");
  });

  it("prefers default/agent/code modes when leaving plan mode", () => {
    expect(resolveImplementationModeId([{ id: "plan" }, { id: "default" }])).toBe("default");
    expect(resolveImplementationModeId([{ id: "plan" }, { id: "agent" }])).toBe("agent");
    expect(resolveImplementationModeId([{ id: "plan" }, { id: "review" }])).toBe("review");
  });
});
