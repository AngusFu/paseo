import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { buildProviderInspectReport, renderProviderInspectHuman } from "./inspect.js";

function entry(
  partial: Partial<ProviderSnapshotEntry> & { provider: ProviderSnapshotEntry["provider"] },
): ProviderSnapshotEntry {
  return {
    status: "ready",
    enabled: true,
    ...partial,
  };
}

describe("buildProviderInspectReport", () => {
  it("dumps modes, models, and thinking ids from the snapshot", async () => {
    const report = await buildProviderInspectReport({
      cwd: "/tmp/project",
      entries: [
        entry({
          provider: "claude",
          label: "Claude Code",
          defaultModeId: "default",
          modes: [{ id: "default", label: "Default" }],
          models: [
            {
              provider: "claude",
              id: "sonnet",
              label: "Sonnet",
              thinkingOptions: [{ id: "high", label: "High" }],
              defaultThinkingOptionId: "high",
            },
          ],
        }),
        entry({
          provider: "cursor",
          label: "Cursor",
          modes: [
            { id: "agent", label: "Agent" },
            { id: "ask", label: "Ask" },
          ],
          models: [
            {
              provider: "cursor",
              id: "composer-2",
              label: "Composer 2",
              thinkingOptions: [],
            },
          ],
        }),
      ],
    });

    expect(report.includeDisabled).toBe(false);
    expect(report.providers).toEqual([
      {
        id: "claude",
        label: "Claude Code",
        status: "available",
        enabled: true,
        error: null,
        defaultModeId: "default",
        modeIds: ["default"],
        modes: [{ id: "default", label: "Default" }],
        models: [
          {
            id: "sonnet",
            label: "Sonnet",
            description: "",
            defaultThinkingOptionId: "high",
            thinkingOptionIds: ["high"],
          },
        ],
      },
      {
        id: "cursor",
        label: "Cursor",
        status: "available",
        enabled: true,
        error: null,
        defaultModeId: null,
        modeIds: ["agent", "ask"],
        modes: [
          { id: "agent", label: "Agent" },
          { id: "ask", label: "Ask" },
        ],
        models: [
          {
            id: "composer-2",
            label: "Composer 2",
            description: "",
            defaultThinkingOptionId: null,
            thinkingOptionIds: [],
          },
        ],
      },
    ]);
  });

  it("omits disabled providers by default and includes them with includeDisabled", async () => {
    const entries = [
      entry({
        provider: "claude",
        label: "Claude Code",
        models: [{ provider: "claude", id: "sonnet", label: "Sonnet" }],
      }),
      entry({
        provider: "cursor",
        label: "Cursor",
        enabled: false,
        status: "unavailable",
        models: [{ provider: "cursor", id: "composer-2", label: "Composer 2" }],
      }),
    ];

    const enabledOnly = await buildProviderInspectReport({
      cwd: "/tmp/project",
      entries,
    });
    expect(enabledOnly.providers.map((provider) => provider.id)).toEqual(["claude"]);

    const withDisabled = await buildProviderInspectReport({
      cwd: "/tmp/project",
      includeDisabled: true,
      entries,
    });
    expect(withDisabled.includeDisabled).toBe(true);
    expect(withDisabled.providers.map((provider) => provider.id)).toEqual(["claude", "cursor"]);
  });

  it("filters to one provider", async () => {
    const report = await buildProviderInspectReport({
      cwd: "/tmp/project",
      providerFilter: "cursor",
      entries: [
        entry({
          provider: "claude",
          label: "Claude Code",
          models: [{ provider: "claude", id: "sonnet", label: "Sonnet" }],
        }),
        entry({
          provider: "cursor",
          label: "Cursor",
          modes: [{ id: "agent", label: "Agent" }],
          models: [{ provider: "cursor", id: "composer-2", label: "Composer 2" }],
        }),
      ],
    });

    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.id).toBe("cursor");
  });

  it("throws when the provider filter matches nothing", async () => {
    await expect(
      buildProviderInspectReport({
        cwd: "/tmp/project",
        providerFilter: "missing",
        entries: [entry({ provider: "claude", label: "Claude" })],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
    });
  });

  it("throws when the provider filter targets a disabled provider without includeDisabled", async () => {
    await expect(
      buildProviderInspectReport({
        cwd: "/tmp/project",
        providerFilter: "cursor",
        entries: [
          entry({
            provider: "cursor",
            label: "Cursor",
            enabled: false,
            status: "unavailable",
          }),
        ],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
    });
  });
});

describe("renderProviderInspectHuman", () => {
  it("renders a compact multi-provider dump", () => {
    const text = renderProviderInspectHuman({
      cwd: "/tmp/project",
      includeDisabled: false,
      fetchedAt: "2026-07-16T00:00:00.000Z",
      providers: [
        {
          id: "claude",
          label: "Claude Code",
          status: "available",
          enabled: true,
          error: null,
          defaultModeId: "default",
          modeIds: ["default"],
          modes: [{ id: "default", label: "Default" }],
          models: [
            {
              id: "sonnet",
              label: "Sonnet",
              description: "",
              defaultThinkingOptionId: "high",
              thinkingOptionIds: ["high"],
            },
          ],
        },
      ],
    });

    expect(text).toContain("cwd: /tmp/project");
    expect(text).toContain("disabled: omitted (pass --all)");
    expect(text).not.toContain("features:");
    expect(text).toContain("claude  [available]");
    expect(text).toContain("model sonnet  thinking=[high]");
  });
});
