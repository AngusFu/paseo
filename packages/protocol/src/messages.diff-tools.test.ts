import { describe, expect, test } from "vitest";

import {
  InstallDifftasticProgressMessageSchema,
  InstallDifftasticRequestMessageSchema,
  InstallDifftasticResponseSchema,
  ParsedDiffFileSchema,
  ServerCapabilitiesSchema,
  SubscribeCheckoutDiffRequestSchema,
} from "./messages.js";

describe("diff tool switch schemas", () => {
  test("parses old checkout diff compare payloads without the new fields", () => {
    const parsed = SubscribeCheckoutDiffRequestSchema.parse({
      type: "subscribe_checkout_diff_request",
      subscriptionId: "sub-1",
      cwd: "/tmp/repo",
      compare: { mode: "uncommitted" },
      requestId: "request-1",
    });

    expect(parsed.compare).toEqual({ mode: "uncommitted" });
  });

  test("parses tool and gitAlgorithm on the compare payload", () => {
    const parsed = SubscribeCheckoutDiffRequestSchema.parse({
      type: "subscribe_checkout_diff_request",
      subscriptionId: "sub-2",
      cwd: "/tmp/repo",
      compare: {
        mode: "base",
        baseRef: "main",
        tool: "difftastic",
        gitAlgorithm: "histogram",
      },
      requestId: "request-2",
    });

    expect(parsed.compare).toMatchObject({
      tool: "difftastic",
      gitAlgorithm: "histogram",
    });
  });

  test("rejects unknown diff tool and git algorithm values", () => {
    expect(() =>
      SubscribeCheckoutDiffRequestSchema.parse({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "sub-3",
        cwd: "/tmp/repo",
        compare: { mode: "uncommitted", tool: "kdiff3" },
        requestId: "request-3",
      }),
    ).toThrow();

    expect(() =>
      SubscribeCheckoutDiffRequestSchema.parse({
        type: "subscribe_checkout_diff_request",
        subscriptionId: "sub-4",
        cwd: "/tmp/repo",
        compare: { mode: "base", gitAlgorithm: "minimal" },
        requestId: "request-4",
      }),
    ).toThrow();
  });

  test("parses a refs compare payload", () => {
    const parsed = SubscribeCheckoutDiffRequestSchema.parse({
      type: "subscribe_checkout_diff_request",
      subscriptionId: "sub-5",
      cwd: "/tmp/repo",
      compare: { mode: "refs", fromRef: "feature/x", toRef: "main", mergeBase: false },
      requestId: "request-5",
    });

    expect(parsed.compare).toMatchObject({
      mode: "refs",
      fromRef: "feature/x",
      toRef: "main",
      mergeBase: false,
    });
  });

  test("parses old parsed diff file payloads without diffTool or changedRanges", () => {
    const parsed = ParsedDiffFileSchema.parse({
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [{ type: "context", content: "unchanged" }],
        },
      ],
    });

    expect(parsed.diffTool).toBeUndefined();
    expect(parsed.hunks[0]?.lines[0]?.changedRanges).toBeUndefined();
  });

  test("parses diffTool marker and word-level changedRanges", () => {
    const parsed = ParsedDiffFileSchema.parse({
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      diffTool: "difftastic",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            {
              type: "remove",
              content: "const x = 1000;",
              changedRanges: [{ start: 10, end: 14 }],
            },
          ],
        },
      ],
    });

    expect(parsed.diffTool).toBe("difftastic");
    expect(parsed.hunks[0]?.lines[0]?.changedRanges).toEqual([{ start: 10, end: 14 }]);
  });

  test("rejects unknown diffTool values", () => {
    expect(() =>
      ParsedDiffFileSchema.parse({
        path: "src/foo.ts",
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        diffTool: "meld",
        hunks: [],
      }),
    ).toThrow();
  });

  test("parses the diffTools server capability with a tri-state difftastic value", () => {
    const parsed = ServerCapabilitiesSchema.parse({
      diffTools: {
        git: "available",
        vscode: "available",
        difftastic: "installable",
      },
    });

    expect(parsed.diffTools).toEqual({
      git: "available",
      vscode: "available",
      difftastic: "installable",
    });
  });

  test("parses the diffTools capability with a difftastic version", () => {
    const parsed = ServerCapabilitiesSchema.parse({
      diffTools: {
        git: "available",
        vscode: "available",
        difftastic: "available",
        difftasticVersion: "0.69.0",
      },
    });

    expect(parsed.diffTools?.difftasticVersion).toBe("0.69.0");
  });

  test("keeps old server capability payloads without diffTools parseable", () => {
    const parsed = ServerCapabilitiesSchema.parse({});

    expect(parsed.diffTools).toBeUndefined();
  });

  test("accepts install_difftastic request, progress, and response messages", () => {
    expect(
      InstallDifftasticRequestMessageSchema.parse({
        type: "install_difftastic_request",
        requestId: "install-1",
      }),
    ).toEqual({
      type: "install_difftastic_request",
      requestId: "install-1",
    });

    expect(
      InstallDifftasticProgressMessageSchema.parse({
        type: "install_difftastic_progress",
        payload: { requestId: "install-1", phase: "downloading" },
      }).payload,
    ).toMatchObject({ phase: "downloading" });

    expect(
      InstallDifftasticResponseSchema.parse({
        type: "install_difftastic_response",
        payload: {
          requestId: "install-1",
          success: true,
          error: null,
          version: "0.69.0",
        },
      }).payload,
    ).toMatchObject({ success: true, version: "0.69.0" });
  });
});
