import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});

describe("workflow draft tab identity", () => {
  it("normalizes a workflow draft target and trims both ids", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "workflow_draft",
        draftId: " draft-1 ",
        definitionId: " wf-1 ",
      }),
    ).toEqual({ kind: "workflow_draft", draftId: "draft-1", definitionId: "wf-1" });
  });

  it("rejects a workflow draft target missing either id", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "workflow_draft",
        draftId: "draft-1",
        definitionId: "  ",
      }),
    ).toBeNull();
    expect(
      normalizeWorkspaceTabTarget({
        kind: "workflow_draft",
        draftId: "",
        definitionId: "wf-1",
      }),
    ).toBeNull();
  });

  it("compares both the draft id and the definition id", () => {
    const target = { kind: "workflow_draft", draftId: "draft-1", definitionId: "wf-1" } as const;

    expect(workspaceTabTargetsEqual(target, { ...target })).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, definitionId: "wf-2" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, draftId: "draft-2" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { kind: "workflow_run", runId: "draft-1" })).toBe(
      false,
    );
  });

  it("keys a workflow draft tab by its draft id", () => {
    expect(
      buildDeterministicWorkspaceTabId({
        kind: "workflow_draft",
        draftId: "draft-1",
        definitionId: "wf-1",
      }),
    ).toBe("workflow_draft_draft-1");
  });
});
