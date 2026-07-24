import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import { describe, expect, it } from "vitest";
import {
  answersFromPermissionResponse,
  toInboxQuestionPermission,
} from "./inbox-question-permission";

const SAMPLE: StoredInboxQuestion = {
  id: "qst_abc",
  agentId: "agent-1",
  createdAt: "2026-07-25T00:00:00.000Z",
  status: "pending",
  title: "Confirm",
  questions: [
    {
      question: "Continue?",
      header: "Continue",
      options: [{ label: "Yes" }],
    },
  ],
  source: "skill",
  mcpRequestId: "mcp-question-1",
};

describe("toInboxQuestionPermission", () => {
  it("maps inbox rows into a question permission for QuestionFormCard", () => {
    const permission = toInboxQuestionPermission(SAMPLE);
    expect(permission.key).toBe("inbox:qst_abc");
    expect(permission.agentId).toBe("agent-1");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.id).toBe("mcp-question-1");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes" }],
        },
      ],
    });
  });

  it("fills empty options arrays when inbox items omit them", () => {
    const permission = toInboxQuestionPermission({
      ...SAMPLE,
      mcpRequestId: undefined,
      questions: [{ question: "Free text?", header: "Text" }],
    });
    expect(permission.request.id).toBe("qst_abc");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Free text?",
          header: "Text",
          options: [],
        },
      ],
    });
  });
});

describe("answersFromPermissionResponse", () => {
  it("maps deny to dismiss", () => {
    expect(
      answersFromPermissionResponse({ behavior: "deny", message: "Dismissed by user" }),
    ).toEqual({ dismiss: true });
  });

  it("extracts allow answers", () => {
    expect(
      answersFromPermissionResponse({
        behavior: "allow",
        updatedInput: { answers: { Continue: "Yes" } },
      }),
    ).toEqual({ answers: { Continue: "Yes" } });
  });
});
