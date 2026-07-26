import { describe, expect, it } from "vitest";

import { mergeFeatureValueLayers, resolveFeatureValues } from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });

  it("merges persisted defaults ahead of resolved draft values for create-agent", () => {
    expect(
      mergeFeatureValueLayers({ auto_accept: true }, { auto_accept: false, fast_mode: true }),
    ).toEqual({
      auto_accept: false,
      fast_mode: true,
    });
    expect(mergeFeatureValueLayers({ auto_accept: true }, {})).toEqual({ auto_accept: true });
  });
});
