import { describe, expect, it } from "vitest";

import {
  collectManagedAgentFeatureValues,
  mergeCreateAgentFeatureValues,
} from "./create-agent-features.js";
import { resolveDefaultAgentCreateConfig } from "./create-agent-mode.js";
import type { ManagedAgent } from "./agent-manager.js";

describe("collectManagedAgentFeatureValues", () => {
  it("merges persisted config values with live feature state", () => {
    const agent = {
      config: { featureValues: { auto_accept: false, fast: "false" } },
      features: [
        { type: "toggle", id: "auto_accept", label: "Auto approve", value: true },
        { type: "select", id: "fast", label: "Fast", value: "true", options: [] },
      ],
    } as Pick<ManagedAgent, "config" | "features">;

    expect(collectManagedAgentFeatureValues(agent)).toEqual({
      auto_accept: true,
      fast: "true",
    });
  });
});

describe("mergeCreateAgentFeatureValues", () => {
  it("lets requested values override inherited ones", () => {
    expect(
      mergeCreateAgentFeatureValues({ auto_accept: true, fast: "false" }, { fast: "true" }),
    ).toEqual({ auto_accept: true, fast: "true" });
  });
});

describe("resolveDefaultAgentCreateConfig", () => {
  it("inherits caller featureValues for same-provider child spawns", () => {
    const resolved = resolveDefaultAgentCreateConfig({
      provider: "cursor",
      requestedMode: undefined,
      featureValues: { fast: "true" },
      parent: {
        provider: "cursor",
        modeId: "agent",
        isUnattended: false,
        featureValues: { auto_accept: true },
      },
      unattended: false,
      availableModes: [{ id: "agent", label: "Agent" }],
    });

    expect(resolved.featureValues).toEqual({ auto_accept: true, fast: "true" });
  });

  it("does not inherit caller featureValues cross-provider", () => {
    const resolved = resolveDefaultAgentCreateConfig({
      provider: "codex",
      requestedMode: "auto",
      featureValues: undefined,
      parent: {
        provider: "cursor",
        modeId: "agent",
        isUnattended: false,
        featureValues: { auto_accept: true },
      },
      unattended: false,
      availableModes: [{ id: "auto", label: "Auto" }],
    });

    expect(resolved.featureValues).toBeUndefined();
  });
});
