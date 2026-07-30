import { describe, expect, test } from "vitest";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  excludeComposerManagedAcpFeatures,
  isAcpProvider,
  isComposerAcpAutoAcceptFeature,
  mergeGlobalAcpAutoApprove,
  migrateGlobalAcpAutoApprovePreferences,
  readGlobalAcpAutoApprove,
  resolveComposerAutoAcceptFeature,
  resolveComposerAutoAcceptSettledValue,
  resolveGlobalAcpAutoAcceptFeatureValues,
  shouldShowComposerAcpAutoAccept,
} from "@/composer/acp-auto-approve";

describe("isAcpProvider", () => {
  test("returns true for manifest-native Copilot", () => {
    expect(isAcpProvider("copilot", null)).toBe(true);
  });

  test("returns true for catalog ACP providers even without config extends", () => {
    expect(isAcpProvider("cursor", { providers: { cursor: { enabled: true } } })).toBe(true);
    expect(isAcpProvider("codewhale", null)).toBe(true);
  });

  test("returns true for cursor-print (shares global Auto Approve)", () => {
    expect(isAcpProvider("cursor-print", null)).toBe(true);
  });

  test("returns false for non-ACP providers", () => {
    expect(isAcpProvider("opencode", null)).toBe(false);
    expect(isAcpProvider("claude", null)).toBe(false);
  });

  test("returns true for custom providers extending acp", () => {
    expect(
      isAcpProvider("my-agent", {
        providers: {
          "my-agent": { extends: "acp", command: ["my-agent", "acp"] },
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

  test("accepts cursor-print auto_accept description", () => {
    expect(
      isComposerAcpAutoAcceptFeature({
        type: "toggle",
        id: ACP_AUTO_ACCEPT_FEATURE_ID,
        label: "Auto Approve",
        description:
          "Automatically approves Cursor print/stream-json interaction_query tool permissions.",
        value: false,
      }),
    ).toBe(true);
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

describe("resolveComposerAutoAcceptFeature", () => {
  const autoAccept = (value: boolean): AgentFeature & { type: "toggle" } => ({
    type: "toggle",
    id: ACP_AUTO_ACCEPT_FEATURE_ID,
    label: "Auto Approve",
    description: "Automatically approves ACP tool permission prompts.",
    value,
  });

  test("ignores an empty draft feature list and falls back to the live agent", () => {
    expect(resolveComposerAutoAcceptFeature([], [autoAccept(true)])).toEqual(autoAccept(true));
  });

  test("prefers draft features when they are loaded", () => {
    expect(resolveComposerAutoAcceptFeature([autoAccept(false)], [autoAccept(true)])).toEqual(
      autoAccept(false),
    );
  });

  test("ignores OpenCode auto_accept on the live agent", () => {
    expect(
      resolveComposerAutoAcceptFeature(undefined, [
        {
          type: "toggle",
          id: ACP_AUTO_ACCEPT_FEATURE_ID,
          label: "Auto Accept",
          description: "Automatically approves OpenCode tool permission prompts.",
          value: true,
        },
      ]),
    ).toBeNull();
  });
});

describe("readGlobalAcpAutoApprove", () => {
  test("reads the global field when present", () => {
    expect(readGlobalAcpAutoApprove({ acpAutoApprove: true })).toBe(true);
  });

  test("migrates legacy per-provider auto_accept values", () => {
    expect(
      readGlobalAcpAutoApprove({
        providerPreferences: {
          cursor: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true } },
          copilot: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: false } },
        },
      }),
    ).toBe(true);
  });

  test("does not infer global off from legacy per-provider false only", () => {
    expect(
      readGlobalAcpAutoApprove({
        providerPreferences: {
          copilot: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: false } },
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveComposerAutoAcceptSettledValue", () => {
  test("prefers draft feature values over global in draft mode", () => {
    expect(
      resolveComposerAutoAcceptSettledValue({
        optimisticValue: null,
        draftMode: true,
        globalAutoApprove: true,
        resolvedFeatureValue: false,
      }),
    ).toBe(false);
  });

  test("prefers global over stale live session values", () => {
    expect(
      resolveComposerAutoAcceptSettledValue({
        optimisticValue: null,
        draftMode: false,
        globalAutoApprove: true,
        resolvedFeatureValue: false,
      }),
    ).toBe(true);
  });
});

describe("resolveGlobalAcpAutoAcceptFeatureValues", () => {
  test("returns auto_accept only for ACP providers", () => {
    expect(
      resolveGlobalAcpAutoAcceptFeatureValues({ acpAutoApprove: true }, "copilot", null),
    ).toEqual({ [ACP_AUTO_ACCEPT_FEATURE_ID]: true });
    expect(
      resolveGlobalAcpAutoAcceptFeatureValues({ acpAutoApprove: true }, "cursor", null),
    ).toEqual({ [ACP_AUTO_ACCEPT_FEATURE_ID]: true });
    expect(
      resolveGlobalAcpAutoAcceptFeatureValues({ acpAutoApprove: true }, "cursor-print", null),
    ).toEqual({ [ACP_AUTO_ACCEPT_FEATURE_ID]: true });
    expect(
      resolveGlobalAcpAutoAcceptFeatureValues({ acpAutoApprove: true }, "claude", null),
    ).toEqual({});
  });
});

describe("migrateGlobalAcpAutoApprovePreferences", () => {
  test("promotes legacy per-provider auto_accept and strips provider feature values", () => {
    expect(
      migrateGlobalAcpAutoApprovePreferences({
        providerPreferences: {
          cursor: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true } },
          copilot: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: false, fast_mode: true } },
        },
      }),
    ).toEqual({
      changed: true,
      preferences: {
        acpAutoApprove: true,
        providerPreferences: {
          cursor: {},
          copilot: { featureValues: { fast_mode: true } },
        },
      },
    });
  });

  test("strips ambiguous legacy false-only auto_accept without setting global off", () => {
    expect(
      migrateGlobalAcpAutoApprovePreferences({
        providerPreferences: {
          copilot: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: false } },
        },
      }),
    ).toEqual({
      changed: true,
      preferences: {
        providerPreferences: {
          copilot: {},
        },
      },
    });
  });

  test("strips legacy auto_accept when global is already set", () => {
    expect(
      migrateGlobalAcpAutoApprovePreferences({
        acpAutoApprove: false,
        providerPreferences: {
          cursor: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: true } },
        },
      }),
    ).toEqual({
      changed: true,
      preferences: {
        acpAutoApprove: false,
        providerPreferences: {
          cursor: {},
        },
      },
    });
  });
});

describe("mergeGlobalAcpAutoApprove", () => {
  test("persists global value and strips legacy provider auto_accept", () => {
    expect(
      mergeGlobalAcpAutoApprove(
        {
          providerPreferences: {
            cursor: { featureValues: { [ACP_AUTO_ACCEPT_FEATURE_ID]: false } },
          },
        },
        true,
      ),
    ).toEqual({
      acpAutoApprove: true,
      providerPreferences: {
        cursor: {},
      },
    });
  });
});
