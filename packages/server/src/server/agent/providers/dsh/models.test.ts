import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveDshModelRoute } from "./models.js";
import { areDshPluginsAvailable, resolveDshNodeModulesSearchPaths } from "./dsh-plugins.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveDshModelRoute", () => {
  test("maps bare model ids to deepseek-official", () => {
    expect(resolveDshModelRoute("deepseek-v4-flash")).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      catalogId: "deepseek-v4-flash",
    });
  });

  test("splits custom pi-ai routes on the first slash only", () => {
    expect(resolveDshModelRoute("x-9router/ollama/gpt-oss:120b")).toEqual({
      provider: "x-9router",
      model: "ollama/gpt-oss:120b",
      catalogId: "x-9router/ollama/gpt-oss:120b",
    });
  });
});

describe("resolveDshNodeModulesSearchPaths", () => {
  test("includes profile plugin node_modules when present", () => {
    const profileHome = mkdtempSync(join(tmpdir(), "dsh-plugins-"));
    tempDirs.push(profileHome);
    const pluginDir = join(profileHome, "paseo");
    const nodeModules = join(pluginDir, "node_modules");
    mkdirSync(join(nodeModules, "@deepseek-ai", "dsh-llm-pi-ai"), { recursive: true });
    mkdirSync(join(nodeModules, "@deepseek-ai", "dsh-credentials-local"), { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), "{}", "utf8");

    const paths = resolveDshNodeModulesSearchPaths({ profileHome });
    expect(paths).toContain(nodeModules);
    expect(areDshPluginsAvailable(paths)).toBe(true);
  });
});
