import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readDshModelCatalog, resolveDshModelRoute } from "./models.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DSH model catalog", () => {
  test("matches better-paseo route parsing and settings discovery", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-acp-models-"));
    tempDirs.push(dshHome);
    writeFileSync(
      join(dshHome, "settings.yaml"),
      `agent-default-model:
  provider: x-9router
  model: ds/deepseek-v4-pro
  reasoningEffort: high
llm-pi-ai:
  providers:
    x-9router:
      displayName: 9router
      models:
        - id: ds/deepseek-v4-pro
          reasoningEfforts:
            low: low
            high: high
`,
    );

    const catalog = readDshModelCatalog(dshHome);
    expect(catalog.defaultModelId).toBe("x-9router/ds/deepseek-v4-pro");
    expect(catalog.defaultReasoningEffort).toBe("high");
    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "deepseek-v4-flash" }),
        expect.objectContaining({
          modelId: "x-9router/ds/deepseek-v4-pro",
          name: "9router: ds/deepseek-v4-pro",
          reasoningEfforts: ["low", "high"],
        }),
      ]),
    );
  });

  test("discovers external DSH LLM plugins like better-paseo", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-acp-plugin-models-"));
    tempDirs.push(dshHome);
    const packageDir = join(dshHome, "profiles", "web", "node_modules", "dsh-llm-custom");
    mkdirSync(join(packageDir, "lib"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "dsh-llm-custom", main: "lib/index.js" }),
    );
    writeFileSync(join(packageDir, "lib", "index.js"), "export default {};\n");
    writeFileSync(
      join(packageDir, "cordis.patch.yml"),
      "- insert:\n    - id: llm-custom\n      name: dsh-llm-custom\n",
    );
    writeFileSync(join(dshHome, "settings.yaml"), "llm-custom:\n  models:\n    - id: model-x\n");

    const catalog = readDshModelCatalog(dshHome);
    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: "custom/model-x", name: "custom: model-x" }),
      ]),
    );
    expect(catalog.pluginEntries[0]).toMatchObject({
      id: "llm-custom",
      providerId: "custom",
    });
  });
});

describe("resolveDshModelRoute", () => {
  test("splits nested model ids on the first slash without provider-specific aliases", () => {
    expect(resolveDshModelRoute("x-9router/ollama/gpt-oss:120b")).toEqual({
      provider: "x-9router",
      model: "ollama/gpt-oss:120b",
      catalogId: "x-9router/ollama/gpt-oss:120b",
    });
    expect(resolveDshModelRoute("github-copilot/gpt-4o")).toEqual({
      provider: "github-copilot",
      model: "gpt-4o",
      catalogId: "github-copilot/gpt-4o",
    });
  });
});
