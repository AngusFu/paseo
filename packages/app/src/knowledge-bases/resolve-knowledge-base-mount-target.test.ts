import { describe, expect, it } from "vitest";
import { resolveKnowledgeBaseMountTarget } from "./resolve-knowledge-base-mount-target";

describe("resolveKnowledgeBaseMountTarget", () => {
  it("prefers the active workspace when it is on the detail host", () => {
    expect(
      resolveKnowledgeBaseMountTarget({
        detailServerId: "host-a",
        active: { serverId: "host-a", workspaceId: "ws-active" },
        last: { serverId: "host-a", workspaceId: "ws-last" },
      }),
    ).toEqual({ serverId: "host-a", workspaceId: "ws-active" });
  });

  it("falls back to the last workspace on the same host", () => {
    expect(
      resolveKnowledgeBaseMountTarget({
        detailServerId: "host-a",
        active: { serverId: "host-b", workspaceId: "ws-other" },
        last: { serverId: "host-a", workspaceId: "ws-last" },
      }),
    ).toEqual({ serverId: "host-a", workspaceId: "ws-last" });
  });

  it("returns null when neither selection is on the detail host", () => {
    expect(
      resolveKnowledgeBaseMountTarget({
        detailServerId: "host-a",
        active: { serverId: "host-b", workspaceId: "ws-b" },
        last: { serverId: "host-c", workspaceId: "ws-c" },
      }),
    ).toBeNull();
  });

  it("returns null when selections are missing", () => {
    expect(
      resolveKnowledgeBaseMountTarget({
        detailServerId: "host-a",
        active: null,
        last: null,
      }),
    ).toBeNull();
  });

  it("ignores blank workspace ids", () => {
    expect(
      resolveKnowledgeBaseMountTarget({
        detailServerId: "host-a",
        active: { serverId: "host-a", workspaceId: "   " },
        last: { serverId: "host-a", workspaceId: "ws-last" },
      }),
    ).toEqual({ serverId: "host-a", workspaceId: "ws-last" });
  });
});
