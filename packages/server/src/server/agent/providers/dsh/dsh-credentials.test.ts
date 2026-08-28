import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { applyDshRuntimeEnv, loadDshCredentialRefs } from "./dsh-credentials.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadDshCredentialRefs", () => {
  test("reads refs from the managed credentials document", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-creds-"));
    tempDirs.push(dshHome);
    writeFileSync(
      join(dshHome, ".credentials.yaml"),
      `version: 1
refs:
  DEEPSEEK_API_KEY: deepseek-key
  X_9ROUTER_API_KEY: nine-router-key
`,
      "utf8",
    );

    expect(loadDshCredentialRefs(dshHome)).toEqual({
      DEEPSEEK_API_KEY: "deepseek-key",
      X_9ROUTER_API_KEY: "nine-router-key",
    });
  });
});

describe("applyDshRuntimeEnv", () => {
  test("sets DSH_HOME and injects credential refs without overriding existing env", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-env-"));
    tempDirs.push(dshHome);
    writeFileSync(
      join(dshHome, ".credentials.yaml"),
      `version: 1
refs:
  X_9ROUTER_API_KEY: from-credentials
`,
      "utf8",
    );

    const env: Record<string, string> = {
      X_9ROUTER_API_KEY: "already-set",
    };
    applyDshRuntimeEnv(env, { dshHome });

    expect(env.DSH_HOME).toBe(dshHome);
    expect(env.X_9ROUTER_API_KEY).toBe("already-set");
  });
});
