import { describe, expect, it } from "vitest";
import { deriveSidebarStateBucket, isSidebarActiveWorkspaceBucket } from "./sidebar-agent-state";

describe("isSidebarActiveWorkspaceBucket", () => {
  it("treats every non-done bucket as active for VFS-sensitive confirms", () => {
    expect(isSidebarActiveWorkspaceBucket("running")).toBe(true);
    expect(isSidebarActiveWorkspaceBucket("needs_input")).toBe(true);
    expect(isSidebarActiveWorkspaceBucket("attention")).toBe(true);
    expect(isSidebarActiveWorkspaceBucket("failed")).toBe(true);
    expect(isSidebarActiveWorkspaceBucket("done")).toBe(false);
  });
});

describe("deriveSidebarStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("needs_input");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveSidebarStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("attention");
  });

  it("does not count initializing agents as running", () => {
    expect(
      deriveSidebarStateBucket({
        status: "initializing",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("done");
  });
});
