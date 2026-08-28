import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  installDshWebWorkspaceBridge,
  resolveDshToolchain,
  setupDshToolchain,
} from "./toolchain.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DSH toolchain", () => {
  test("discovers the managed deepseek-harness-sdk runtime", () => {
    const dshHome = createToolchain();
    const toolchain = resolveDshToolchain({ dshHome, env: { PATH: "" } });

    expect(toolchain).toEqual({
      runtimeBin: expect.stringContaining(runtimeBinaryName()),
      cordisPath: expect.stringContaining("deepseek_harness_runtime/runtime/cordis.yml"),
    });
  });

  test("setup is idempotent when the managed runtime exists", async () => {
    const dshHome = createToolchain();
    let runCount = 0;
    const toolchain = await setupDshToolchain({
      dshHome,
      env: { PATH: "" },
      run: async () => {
        runCount += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(toolchain.runtimeBin).toContain(runtimeBinaryName());
    expect(runCount).toBe(0);
  });

  test("installs the Web workspace bridge idempotently", () => {
    const dshHome = mkdtempSync(join(tmpdir(), "dsh-acp-web-profile-"));
    tempDirs.push(dshHome);
    const profile = join(dshHome, "profiles", "web");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "package.json"), "{}\n");
    writeFileSync(join(profile, "cordis.patch.yml"), "- id: existing\n  disabled: true\n");

    expect(installDshWebWorkspaceBridge(dshHome)).toBe(true);
    expect(installDshWebWorkspaceBridge(dshHome)).toBe(true);
    const patch = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
    expect(patch.match(/dsh-acp-workspace-bridge: begin/g)).toHaveLength(1);
    expect(patch).toContain("dsh-acp-workspace-host");
    expect(existsSync(join(dshHome, "paseo", "dsh-acp-web-workspace.js"))).toBe(true);
  });
});

function createToolchain(): string {
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-acp-toolchain-"));
  tempDirs.push(dshHome);
  const runtimeDir = join(
    dshHome,
    "toolchains",
    "dsh-runtime",
    ".venv",
    "lib",
    "python3.14",
    "site-packages",
    "deepseek_harness_runtime",
    "runtime",
  );
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, runtimeBinaryName()), "runtime", { mode: 0o755 });
  writeFileSync(join(runtimeDir, "cordis.yml"), "[]\n");
  return dshHome;
}

function runtimeBinaryName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "dsh-jsonrpc-agent-pkg-macos-arm64";
  }
  if (process.platform === "darwin") {
    return "dsh-jsonrpc-agent-pkg-macos-x64";
  }
  if (process.platform === "win32") {
    return "dsh-jsonrpc-agent-pkg-win-x64.exe";
  }
  return "dsh-jsonrpc-agent-pkg-linux-x64";
}
