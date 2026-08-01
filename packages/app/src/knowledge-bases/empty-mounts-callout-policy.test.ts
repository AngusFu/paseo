import { describe, expect, it } from "vitest";
import {
  buildEmptyMountsCalloutPolicy,
  shouldShowEmptyMountsCallout,
} from "./empty-mounts-callout-policy";

describe("shouldShowEmptyMountsCallout", () => {
  it("shows only when capability is on and mounts loaded empty", () => {
    expect(
      shouldShowEmptyMountsCallout({
        supported: true,
        loadState: { status: "loaded", data: [] },
      }),
    ).toBe(true);

    expect(
      shouldShowEmptyMountsCallout({
        supported: true,
        loadState: {
          status: "loaded",
          data: [{ knowledgeBaseId: "kb_1", mountSlug: "runbooks" }],
        },
      }),
    ).toBe(false);

    expect(
      shouldShowEmptyMountsCallout({
        supported: false,
        loadState: { status: "loaded", data: [] },
      }),
    ).toBe(false);

    expect(
      shouldShowEmptyMountsCallout({
        supported: true,
        loadState: { status: "loading" },
      }),
    ).toBe(false);

    expect(
      shouldShowEmptyMountsCallout({
        supported: true,
        loadState: { status: "connecting" },
      }),
    ).toBe(false);
  });
});

describe("buildEmptyMountsCalloutPolicy", () => {
  it("keys dismissal by serverId and workspaceId with priority below worktree setup", () => {
    expect(
      buildEmptyMountsCalloutPolicy({
        serverId: "server-1",
        workspaceId: "ws_abc",
      }),
    ).toMatchObject({
      id: "knowledge-bases-empty-mounts:server-1:ws_abc",
      dismissalKey: "knowledge-bases-empty-mounts:server-1:ws_abc",
      priority: 90,
      testID: "knowledge-bases-empty-mounts-callout-ws_abc",
      serverId: "server-1",
      workspaceId: "ws_abc",
    });
  });
});
