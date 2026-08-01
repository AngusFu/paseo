import { beforeEach, describe, expect, it } from "vitest";
import {
  clearKnowledgeBaseMountsSheetRequest,
  requestOpenKnowledgeBaseMountsSheet,
  useKnowledgeBaseMountsSheetRequestStore,
} from "./knowledge-base-mounts-sheet-request-store";

describe("knowledge-base-mounts-sheet-request-store", () => {
  beforeEach(() => {
    clearKnowledgeBaseMountsSheetRequest();
  });

  it("stores a request with an incrementing id", () => {
    requestOpenKnowledgeBaseMountsSheet({
      serverId: "host-a",
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
    });
    const first = useKnowledgeBaseMountsSheetRequestStore.getState().request;
    expect(first).toEqual({
      id: expect.any(Number),
      serverId: "host-a",
      workspaceId: "ws-1",
      knowledgeBaseId: "kb-1",
    });

    requestOpenKnowledgeBaseMountsSheet({
      serverId: "host-a",
      workspaceId: "ws-2",
    });
    const second = useKnowledgeBaseMountsSheetRequestStore.getState().request;
    expect(second?.workspaceId).toBe("ws-2");
    expect(second?.knowledgeBaseId).toBeUndefined();
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);
  });

  it("ignores blank server or workspace ids", () => {
    requestOpenKnowledgeBaseMountsSheet({
      serverId: "  ",
      workspaceId: "ws-1",
    });
    expect(useKnowledgeBaseMountsSheetRequestStore.getState().request).toBeNull();
  });

  it("clears the pending request", () => {
    requestOpenKnowledgeBaseMountsSheet({
      serverId: "host-a",
      workspaceId: "ws-1",
    });
    clearKnowledgeBaseMountsSheetRequest();
    expect(useKnowledgeBaseMountsSheetRequestStore.getState().request).toBeNull();
  });
});
