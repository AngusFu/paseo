import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import {
  extractInboxQuestionsFromPermission,
  headerKeyedAnswersFromPermissionResponse,
  isNativeQuestionPermission,
} from "./native-mirror.js";

function questionRequest(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    id: "permission-abc",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: [
        {
          question: "Ship it?",
          header: "Ship",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    },
    ...overrides,
  };
}

describe("isNativeQuestionPermission", () => {
  it("accepts Claude-style permission ids", () => {
    expect(isNativeQuestionPermission(questionRequest())).toBe(true);
  });

  it("rejects MCP / inbox / plan-execute disguises", () => {
    expect(isNativeQuestionPermission(questionRequest({ id: "mcp-question-1" }))).toBe(false);
    expect(isNativeQuestionPermission(questionRequest({ id: "inbox-question-qst_1" }))).toBe(false);
    expect(isNativeQuestionPermission(questionRequest({ id: "plan-execute-question-1" }))).toBe(
      false,
    );
  });

  it("rejects non-question kinds", () => {
    expect(isNativeQuestionPermission(questionRequest({ kind: "tool" }))).toBe(false);
  });
});

describe("headerKeyedAnswersFromPermissionResponse", () => {
  const questions = extractInboxQuestionsFromPermission(questionRequest());
  if (!questions) {
    throw new Error("expected questions");
  }

  it("maps Claude question-text keys onto headers", () => {
    expect(
      headerKeyedAnswersFromPermissionResponse({
        questions,
        response: {
          behavior: "allow",
          updatedInput: { answers: { "Ship it?": "Yes" } },
        },
      }),
    ).toEqual({ Ship: "Yes" });
  });

  it("keeps header keys from the shared UI", () => {
    expect(
      headerKeyedAnswersFromPermissionResponse({
        questions,
        response: {
          behavior: "allow",
          updatedInput: { answers: { Ship: "No" } },
        },
      }),
    ).toEqual({ Ship: "No" });
  });

  it("returns null on dismiss", () => {
    expect(
      headerKeyedAnswersFromPermissionResponse({
        questions,
        response: { behavior: "deny", message: "Dismissed by user" },
      }),
    ).toBeNull();
  });
});
