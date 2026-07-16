import { describe, expect, it } from "vitest";
import {
  WORKFLOW_WORKSPACE_EMOJI_PREFIX,
  formatWorkflowWorkspaceTitle,
  stripWorkflowWorkspaceEmojiPrefix,
} from "./workspace-title.js";

describe("formatWorkflowWorkspaceTitle", () => {
  it("prefixes a bare body with the locked emoji", () => {
    expect(formatWorkflowWorkspaceTitle("SCIF-5041")).toBe(
      `${WORKFLOW_WORKSPACE_EMOJI_PREFIX}SCIF-5041`,
    );
  });

  it("does not double-prefix when the emoji is already present", () => {
    expect(formatWorkflowWorkspaceTitle("⚙️ SCIF-5041")).toBe(
      `${WORKFLOW_WORKSPACE_EMOJI_PREFIX}SCIF-5041`,
    );
    expect(formatWorkflowWorkspaceTitle("⚙️SCIF-5041")).toBe(
      `${WORKFLOW_WORKSPACE_EMOJI_PREFIX}SCIF-5041`,
    );
  });

  it("falls back when the body is empty", () => {
    expect(formatWorkflowWorkspaceTitle("   ", "autopilot")).toBe(
      `${WORKFLOW_WORKSPACE_EMOJI_PREFIX}autopilot`,
    );
  });
});

describe("stripWorkflowWorkspaceEmojiPrefix", () => {
  it("removes the locked prefix for editing", () => {
    expect(stripWorkflowWorkspaceEmojiPrefix("⚙️ autopilot")).toBe("autopilot");
  });
});
