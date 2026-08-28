import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { materializeDshCordis, mergeCordisEntries } from "./dsh-cordis.js";
import type { DshProfileState } from "./dsh-profile.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createBaseCordis(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-cordis-base-"));
  tempDirs.push(dir);
  const path = join(dir, "cordis.yml");
  writeFileSync(
    path,
    `- id: base
  name: base-plugin
`,
    "utf8",
  );
  return path;
}

function createProfile(overrides: Partial<DshProfileState> = {}): DshProfileState {
  const profilePath = mkdtempSync(join(tmpdir(), "dsh-profile-"));
  tempDirs.push(profilePath);
  return {
    profilePath,
    settingsPath: join(profilePath, "settings.yaml"),
    cordisPatchPath: join(profilePath, "cordis.patch.yml"),
    settings: {
      "llm-pi-ai": {
        providers: {
          "x-9router": {
            displayName: "9Router",
            models: [{ id: "glm-5" }],
          },
        },
      },
    },
    cordisPatch: [
      {
        id: "custom-plugin",
        name: "@scope/custom",
        config: { enabled: true },
      },
    ],
    plugins: [],
    nodeModulesPath: join(profilePath, "node_modules"),
    sessionRoot: join(profilePath, "sessions"),
    ...overrides,
  };
}

describe("mergeCordisEntries", () => {
  test("merges llm providers, session MCP, and profile patch", () => {
    const merged = mergeCordisEntries([{ id: "base", name: "base-plugin" }], createProfile(), {
      paseo: {
        type: "stdio",
        command: "paseo-mcp",
      },
    });

    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "base" }),
        expect.objectContaining({
          id: "llm-pi-ai",
          config: {
            providers: {
              "x-9router": {
                displayName: "9Router",
                models: [{ id: "glm-5" }],
              },
            },
          },
        }),
        expect.objectContaining({
          id: "mcp-paseo",
          name: "@deepseek-ai/dsh-mcp-client",
        }),
        expect.objectContaining({ id: "custom-plugin" }),
      ]),
    );
  });
});

describe("materializeDshCordis", () => {
  test("writes a temporary cordis file and cleans up", () => {
    const baseCordisPath = createBaseCordis();
    const materialized = materializeDshCordis({
      baseCordisPath,
      profile: createProfile(),
      sessionMcpServers: undefined,
    });

    const text = readFileSync(materialized.path, "utf8");
    expect(text).toContain("llm-pi-ai");
    expect(text).toContain("custom-plugin");

    materialized.cleanup();
    expect(() => readFileSync(materialized.path, "utf8")).toThrow();
  });

  test("preserves DSH !!js tags from the bundled base cordis", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-cordis-js-"));
    tempDirs.push(dir);
    const baseCordisPath = join(dir, "cordis.yml");
    writeFileSync(
      baseCordisPath,
      `- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
`,
      "utf8",
    );

    const materialized = materializeDshCordis({
      baseCordisPath,
      profile: createProfile({
        settings: {},
        cordisPatch: [],
      }),
      sessionMcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6768/mcp/agents?callerAgentId=agent-1",
        },
      },
    });

    const text = readFileSync(materialized.path, "utf8");
    expect(text).toContain("!!js process.env.DSH_SESSION_ROOT ?? './.sessions'");
    expect(text).toContain("mcp-paseo");

    materialized.cleanup();
  });
});
