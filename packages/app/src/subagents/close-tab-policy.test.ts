import {
  WORKFLOW_RUN_ID_LABEL,
  WORKFLOW_RUN_WORKSPACE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(
      resolveCloseAgentTabPolicy({ parentAgentId: null, labels: {}, workspaceId: "ws-1" }),
    ).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: "parent-agent",
        labels: {},
        workspaceId: "ws-1",
      }),
    ).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps a folded workflow-run agent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: {
          [WORKFLOW_RUN_ID_LABEL]: "wfr_1",
          [WORKFLOW_RUN_WORKSPACE_LABEL]: "ws-1",
        },
        workspaceId: "ws-1",
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("keeps layout-only when an older daemon stamped no run workspace", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: { [WORKFLOW_RUN_ID_LABEL]: "wfr_1" },
        workspaceId: "ws-1",
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("archives a worktree-isolated run agent in its own workspace on close", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: {
          [WORKFLOW_RUN_ID_LABEL]: "wfr_1",
          [WORKFLOW_RUN_WORKSPACE_LABEL]: "ws-home",
        },
        workspaceId: "ws-isolated",
      }),
    ).toEqual({ kind: "archive-on-close" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});
