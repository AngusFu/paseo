import { describe, expect, it } from "vitest";
import type { PendingPermission } from "@/types/shared";
import {
  isInboxQuestionPermissionRequestId,
  selectVisiblePendingPermissions,
} from "./select-visible-pending-permissions";

function permission(input: {
  id: string;
  kind?: PendingPermission["request"]["kind"];
  key?: string;
}): PendingPermission {
  return {
    key: input.key ?? input.id,
    agentId: "agent-1",
    request: {
      id: input.id,
      provider: "codex",
      name: "AskUserQuestion",
      kind: input.kind ?? "question",
      input: { questions: [] },
    },
  };
}

describe("isInboxQuestionPermissionRequestId", () => {
  it("recognizes mcp and skill inbox ids", () => {
    expect(isInboxQuestionPermissionRequestId("mcp-question-1")).toBe(true);
    expect(isInboxQuestionPermissionRequestId("inbox-question-abc")).toBe(true);
    expect(isInboxQuestionPermissionRequestId("plan-execute-question-1")).toBe(false);
    expect(isInboxQuestionPermissionRequestId("tool-1")).toBe(false);
  });
});

describe("selectVisiblePendingPermissions", () => {
  it("keeps only the newest inbox question form", () => {
    const older = permission({ id: "mcp-question-old" });
    const newer = permission({ id: "mcp-question-new" });
    const tool = permission({ id: "bash-1", kind: "tool" });

    expect(selectVisiblePendingPermissions([older, tool, newer])).toEqual([tool, newer]);
  });

  it("does not hide plan-execute CTAs", () => {
    const plan = permission({ id: "plan-execute-question-1" });
    const inbox = permission({ id: "mcp-question-1" });

    expect(selectVisiblePendingPermissions([plan, inbox])).toEqual([plan, inbox]);
  });

  it("returns non-inbox permissions unchanged when there is no inbox question", () => {
    const tool = permission({ id: "bash-1", kind: "tool" });
    expect(selectVisiblePendingPermissions([tool])).toEqual([tool]);
  });
});
