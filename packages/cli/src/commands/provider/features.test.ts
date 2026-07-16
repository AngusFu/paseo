import { describe, expect, test } from "vitest";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { toFeatureListItems } from "./features.js";

describe("toFeatureListItems", () => {
  test("formats toggle and select features for CLI rows", () => {
    const features: AgentFeature[] = [
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        description: "Priority inference",
        value: true,
      },
      {
        type: "select",
        id: "fast",
        label: "Fast",
        value: "false",
        options: [
          { id: "false", label: "Off", isDefault: true },
          { id: "true", label: "Fast", isDefault: false },
        ],
      },
    ];

    expect(toFeatureListItems(features)).toEqual([
      {
        id: "fast_mode",
        type: "toggle",
        label: "Fast",
        value: "true",
        options: "-",
        description: "Priority inference",
      },
      {
        id: "fast",
        type: "select",
        label: "Fast",
        value: "false",
        options: "false (Off), true (Fast)",
        description: "",
      },
    ]);
  });
});
