import { describe, expect, test } from "vitest";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  excludeComposerManagedAcpFeatures,
  isAcpProvider,
  isComposerAcpAutoAcceptFeature,
  shouldShowComposerAcpAutoAccept,
} from "@/composer/acp-auto-approve";

describe("isAcpProvider", () => {
  test("returns true for built-in Copilot", () => {
    expect(isAcpProvider("copilot", null)).toBe(true);
  });

  test("returns false for non-ACP providers", () => {
    expect(isAcpProvider("opencode", null)).toBe(false);
    expect(isAcpProvider("claude", null)).toBe(false);
  });

  test("returns true for custom providers extending acp", () => {
    expect(
      isAcpProvider("cursor", {
        providers: {
          cursor: { extends: "acp", command: ["cursor-agent", "acp"] },
        },
      }),
    ).toBe(true);
  });
});

describe("excludeComposerManagedAcpFeatures", () => {
  test("removes auto_accept from agent controls when composer owns it", () => {
    const features = [
      {
        type: "toggle" as const,
        id: ACP_AUTO_ACCEPT_FEATURE_ID,
        label: "Auto Approve",
        description: "Automatically approves ACP tool permission prompts.",
        value: false,
      },
      {
        type: "select" as const,
        id: "agent",
        label: "Agent",
        value: null,
        options: [],
      },
    ];

    expect(excludeComposerManagedAcpFeatures(features)).toEqual([features[1]]);
  });
});

describe("isComposerAcpAutoAcceptFeature", () => {
  test("accepts ACP auto_accept and rejects OpenCode", () => {
    expect(
      isComposerAcpAutoAcceptFeature({
        type: "toggle",
        id: ACP_AUTO_ACCEPT_FEATURE_ID,
        label: "Auto Approve",
        description: "Automatically approves ACP tool permission prompts.",
        value: false,
      }),
    ).toBe(true);
    expect(
      isComposerAcpAutoAcceptFeature({
        type: "toggle",
        id: ACP_AUTO_ACCEPT_FEATURE_ID,
        label: "Auto Accept",
        description: "Automatically approves OpenCode tool permission prompts.",
        value: false,
      }),
    ).toBe(false);
  });
});

describe("shouldShowComposerAcpAutoAccept", () => {
  test("shows for cursor when feature metadata is ACP even without config extends", () => {
    expect(
      shouldShowComposerAcpAutoAccept({
        provider: "cursor",
        config: { providers: { cursor: { enabled: true } } },
        feature: {
          type: "toggle",
          id: ACP_AUTO_ACCEPT_FEATURE_ID,
          label: "Auto Approve",
          description: "Automatically approves ACP tool permission prompts.",
          value: false,
        },
      }),
    ).toBe(true);
  });

  test("hides for OpenCode", () => {
    expect(
      shouldShowComposerAcpAutoAccept({
        provider: "opencode",
        config: null,
        feature: {
          type: "toggle",
          id: ACP_AUTO_ACCEPT_FEATURE_ID,
          label: "Auto Accept",
          description: "Automatically approves OpenCode tool permission prompts.",
          value: false,
        },
      }),
    ).toBe(false);
  });
});
