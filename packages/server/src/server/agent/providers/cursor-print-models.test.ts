import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  CURSOR_PRINT_BARE_EFFORT_ID,
  composeCursorPrintWireModel,
  cursorPrintModelSupportsFast,
  groupCursorPrintModels,
  isCursorPrintWireModelId,
  matchCursorPrintCatalogFromDisplayLabel,
  normalizeCursorPrintBaseModelId,
  parseCursorPrintDisplayLabel,
  parseCursorPrintModelId,
  resolveCursorPrintWireModel,
} from "./cursor-print-models.js";

describe("parseCursorPrintModelId", () => {
  test.each([
    [
      "composer-2.5",
      { baseId: "composer-2.5", effortId: CURSOR_PRINT_BARE_EFFORT_ID, fast: false },
    ],
    [
      "composer-2.5-fast",
      { baseId: "composer-2.5", effortId: CURSOR_PRINT_BARE_EFFORT_ID, fast: true },
    ],
    ["cursor-grok-4.5-high", { baseId: "cursor-grok-4.5", effortId: "high", fast: false }],
    ["cursor-grok-4.5-high-fast", { baseId: "cursor-grok-4.5", effortId: "high", fast: true }],
    ["cursor-grok-4.5-low-fast", { baseId: "cursor-grok-4.5", effortId: "low", fast: true }],
    ["gpt-5.2-xhigh-fast", { baseId: "gpt-5.2", effortId: "xhigh", fast: true }],
    ["gpt-5.5-extra-high", { baseId: "gpt-5.5", effortId: "extra-high", fast: false }],
    ["gpt-5.5-extra-high-fast", { baseId: "gpt-5.5", effortId: "extra-high", fast: true }],
    ["gpt-5.4-mini-medium", { baseId: "gpt-5.4-mini", effortId: "medium", fast: false }],
    ["gemini-3.6-flash-minimal", { baseId: "gemini-3.6-flash", effortId: "minimal", fast: false }],
    ["kimi-k3-max", { baseId: "kimi-k3", effortId: "max", fast: false }],
    ["glm-5.2-high", { baseId: "glm-5.2", effortId: "high", fast: false }],
    [
      "gpt-5.3-codex-fast",
      { baseId: "gpt-5.3-codex", effortId: CURSOR_PRINT_BARE_EFFORT_ID, fast: true },
    ],
    ["auto", { baseId: "auto", effortId: CURSOR_PRINT_BARE_EFFORT_ID, fast: false }],
  ] as const)("parses %s", (wireId, expected) => {
    expect(parseCursorPrintModelId(wireId)).toEqual({ ...expected, wireId });
  });

  test("rejects Cursor system/init display labels", () => {
    expect(isCursorPrintWireModelId("Cursor Grok 4.5 High Fast")).toBe(false);
    expect(parseCursorPrintModelId("Cursor Grok 4.5 High Fast")).toBeNull();
    expect(parseCursorPrintModelId("Composer 2.5 Fast")).toBeNull();
    expect(normalizeCursorPrintBaseModelId("Cursor Grok 4.5 High Fast")).toBeNull();
  });

  test("rejects single-word display labels that carry no whitespace", () => {
    expect(isCursorPrintWireModelId("Auto")).toBe(false);
    expect(isCursorPrintWireModelId("Composer")).toBe(false);
    expect(parseCursorPrintModelId("Auto")).toBeNull();
    expect(normalizeCursorPrintBaseModelId("Auto")).toBeNull();
    expect(isCursorPrintWireModelId("auto")).toBe(true);
  });
});

describe("parseCursorPrintDisplayLabel / matchCursorPrintCatalogFromDisplayLabel", () => {
  test("recovers grok high-fast from system/init label", () => {
    expect(parseCursorPrintDisplayLabel("Cursor Grok 4.5 High Fast")).toEqual({
      baseHint: "Cursor Grok 4.5",
      effortId: "high",
      fast: true,
    });
    const catalog = groupCursorPrintModels(
      [
        { id: "cursor-grok-4.5-high", label: "Cursor Grok 4.5" },
        { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5 Fast" },
        { id: "cursor-grok-4.5-low", label: "Cursor Grok 4.5 Low" },
      ],
      "cursor-print",
    );
    expect(matchCursorPrintCatalogFromDisplayLabel("Cursor Grok 4.5 High Fast", catalog)).toEqual({
      baseId: "cursor-grok-4.5",
      effortId: "high",
      fast: true,
    });
  });
});

describe("composeCursorPrintWireModel", () => {
  test("round-trips effort and fast suffixes", () => {
    expect(
      composeCursorPrintWireModel({
        baseId: "cursor-grok-4.5",
        effortId: "medium",
        fast: true,
      }),
    ).toBe("cursor-grok-4.5-medium-fast");
    expect(
      composeCursorPrintWireModel({
        baseId: "composer-2.5",
        effortId: CURSOR_PRINT_BARE_EFFORT_ID,
        fast: true,
      }),
    ).toBe("composer-2.5-fast");
    expect(
      composeCursorPrintWireModel({
        baseId: "gpt-5.5",
        effortId: "extra-high",
        fast: false,
      }),
    ).toBe("gpt-5.5-extra-high");
  });
});

describe("groupCursorPrintModels", () => {
  test("collapses composer and grok variants into base models with effort/fast metadata", () => {
    const models = groupCursorPrintModels(
      [
        { id: "composer-2.5", label: "Composer 2.5", isDefault: true },
        { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
        { id: "cursor-grok-4.5-high", label: "Cursor Grok 4.5" },
        { id: "cursor-grok-4.5-high-fast", label: "Cursor Grok 4.5 Fast" },
        { id: "cursor-grok-4.5-low", label: "Cursor Grok 4.5 Low" },
        { id: "cursor-grok-4.5-medium", label: "Cursor Grok 4.5 Medium" },
      ],
      "cursor-print",
    );

    expect(models.map((model) => model.id)).toEqual(["composer-2.5", "cursor-grok-4.5"]);
    expect(models[0]).toMatchObject({
      id: "composer-2.5",
      label: "Composer 2.5",
      isDefault: true,
      thinkingOptions: undefined,
      metadata: { cursorPrintSupportsFast: true },
    });
    expect(models[1]).toMatchObject({
      id: "cursor-grok-4.5",
      label: "Cursor Grok 4.5",
      defaultThinkingOptionId: "high",
      metadata: { cursorPrintSupportsFast: true },
    });
    expect(models[1]?.thinkingOptions?.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  test("keeps gpt-5.4-mini separate from gpt-5.4 and exposes none..xhigh efforts", () => {
    const models = groupCursorPrintModels(
      [
        { id: "gpt-5.4-medium", label: "GPT-5.4 1M" },
        { id: "gpt-5.4-high", label: "GPT-5.4 1M High" },
        { id: "gpt-5.4-mini-none", label: "GPT-5.4 Mini None" },
        { id: "gpt-5.4-mini-medium", label: "GPT-5.4 Mini" },
        { id: "gpt-5.4-mini-xhigh", label: "GPT-5.4 Mini Extra High" },
      ],
      "cursor-print",
    );

    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
    expect(
      models.find((model) => model.id === "gpt-5.4-mini")?.thinkingOptions?.map((o) => o.id),
    ).toEqual(["none", "medium", "xhigh"]);
    expect(
      models.find((model) => model.id === "gpt-5.4-mini")?.metadata?.cursorPrintSupportsFast,
    ).toBe(false);
  });
});

describe("resolveCursorPrintWireModel", () => {
  test("composes from base + thinking + fast", () => {
    expect(
      resolveCursorPrintWireModel({
        modelId: "cursor-grok-4.5",
        thinkingOptionId: "low",
        fast: true,
      }),
    ).toBe("cursor-grok-4.5-low-fast");
  });

  test("passes legacy wire ids through when effort/fast are not overridden", () => {
    expect(
      resolveCursorPrintWireModel({
        modelId: "cursor-grok-4.5-high-fast",
      }),
    ).toBe("cursor-grok-4.5-high-fast");
  });

  test("falls back to a catalog wire id when the exact combo is missing", () => {
    const [model] = groupCursorPrintModels(
      [
        { id: "gpt-5.4-mini-medium", label: "GPT-5.4 Mini" },
        { id: "gpt-5.4-mini-high", label: "GPT-5.4 Mini High" },
      ],
      "cursor-print",
    );
    expect(
      resolveCursorPrintWireModel({
        modelId: "gpt-5.4-mini",
        thinkingOptionId: "high",
        fast: true,
        model,
      }),
    ).toBe("gpt-5.4-mini-high");
  });

  test("never returns a display label as a wire model", () => {
    expect(
      resolveCursorPrintWireModel({
        modelId: "Cursor Grok 4.5 High Fast",
        thinkingOptionId: "high",
        fast: true,
      }),
    ).toBeNull();
  });

  test("never glues -fast onto a single-word display label", () => {
    // Regression: persisted model "Auto" + stale fast_mode composed "Auto-fast",
    // which the Cursor CLI rejects outright.
    expect(resolveCursorPrintWireModel({ modelId: "Auto", fast: true })).toBeNull();
  });

  test("drops stale fast when the catalog model has no fast variant", () => {
    const [model] = groupCursorPrintModels([{ id: "auto", label: "Auto" }], "cursor-print");
    expect(cursorPrintModelSupportsFast(model)).toBe(false);
    expect(
      resolveCursorPrintWireModel({
        modelId: "auto",
        fast: true,
        model,
      }),
    ).toBe("auto");
  });
});

describe("normalizeCursorPrintBaseModelId", () => {
  test("strips effort/fast suffixes", () => {
    expect(normalizeCursorPrintBaseModelId("gpt-5.2-xhigh-fast")).toBe("gpt-5.2");
    expect(normalizeCursorPrintBaseModelId("composer-2.5")).toBe("composer-2.5");
  });
});

describe("cursor model list fixture", () => {
  test("groups the live agent models dump without dropping wire ids", () => {
    // Optional fixture written by agents during local exploration.
    let stdout: string;
    try {
      stdout = readFileSync("/tmp/cursor-models.txt", "utf8");
    } catch {
      return;
    }

    const raw = stdout.split("\n").flatMap((line) => {
      const trimmed = line.trim();
      const idx = trimmed.indexOf(" - ");
      if (idx < 0 || trimmed.startsWith("Tip:") || trimmed === "Available models") {
        return [];
      }
      return [
        {
          id: trimmed.slice(0, idx).trim(),
          label: trimmed
            .slice(idx + 3)
            .replace(/\s+\((?:current|default)\)$/i, "")
            .trim(),
          isDefault: /\(default\)/i.test(trimmed),
        },
      ];
    });

    const grouped = groupCursorPrintModels(raw, "cursor-print");
    const wireIds = new Set(raw.map((row) => row.id));
    for (const model of grouped) {
      const listed = model.metadata?.cursorPrintWireIds;
      expect(Array.isArray(listed)).toBe(true);
      for (const wireId of listed as string[]) {
        expect(wireIds.has(wireId)).toBe(true);
        const parsed = parseCursorPrintModelId(wireId);
        expect(parsed?.baseId).toBe(model.id);
      }
    }

    // Provider picker should show base families, not every effort/fast row.
    expect(grouped.length).toBeLessThan(raw.length);
    expect(grouped.some((model) => model.id === "composer-2.5")).toBe(true);
    expect(grouped.some((model) => model.id === "cursor-grok-4.5")).toBe(true);
    expect(grouped.some((model) => model.id === "composer-2.5-fast")).toBe(false);
    expect(grouped.some((model) => model.id === "cursor-grok-4.5-high")).toBe(false);
  });
});
