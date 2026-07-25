import { delimiter, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTerminalEnvironment } from "./terminal.js";
import { mcpCliBinDir } from "../server/mcp-cli/paths.js";

const hasZsh = spawnSync("zsh", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;
const zshenvSource = fileURLToPath(new URL("./shell-integration/zsh/.zshenv", import.meta.url));
const integrationSource = fileURLToPath(
  new URL("./shell-integration/zsh/paseo-integration.zsh", import.meta.url),
);

describe("buildTerminalEnvironment mcp-cli PATH", () => {
  it("prepends mcp-cli/bin and exports PASEO_MCP_CLI_BIN when the bin dir exists", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-mcp-cli-path-"));
    try {
      const binDir = mcpCliBinDir(paseoHome);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "figma"), "#!/bin/sh\necho ok\n", { mode: 0o755 });

      const env = buildTerminalEnvironment({
        shell: "/bin/bash",
        env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
        paseoHome,
        paseoCliBinDir: null,
        paseoHookCliPath: null,
      });

      expect(env.PASEO_MCP_CLI_BIN).toBe(binDir);
      expect(env.PATH?.split(delimiter)[0]).toBe(binDir);
    } finally {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });

  it("skips mcp-cli PATH when the bin dir is missing", () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-mcp-cli-missing-"));
    try {
      const env = buildTerminalEnvironment({
        shell: "/bin/bash",
        env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
        paseoHome,
        paseoCliBinDir: null,
        paseoHookCliPath: null,
      });
      expect(env.PASEO_MCP_CLI_BIN).toBeUndefined();
      expect(env.PATH?.split(delimiter)).toEqual(["/usr/bin", "/bin"]);
    } finally {
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasZsh)("re-asserts mcp-cli PATH after user .zshenv overwrites PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-mcp-cli-zsh-"));
    try {
      const paseoHome = join(root, "home");
      const binDir = mcpCliBinDir(paseoHome);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "figma"), "#!/bin/sh\necho ok\n");
      chmodSync(join(binDir, "figma"), 0o755);

      const userZdot = join(root, "user-zdot");
      mkdirSync(userZdot, { recursive: true });
      writeFileSync(join(userZdot, ".zshenv"), 'export PATH="/usr/bin:/bin"\n');

      const integrationDir = join(root, "integration");
      mkdirSync(integrationDir, { recursive: true });
      copyFileSync(zshenvSource, join(integrationDir, ".zshenv"));
      copyFileSync(integrationSource, join(integrationDir, "paseo-integration.zsh"));

      const result = spawnSync("zsh", ["-c", 'print -r -- "$PATH"; command -v figma'], {
        encoding: "utf8",
        env: {
          HOME: root,
          PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
          PASEO_MCP_CLI_BIN: binDir,
          PASEO_ZSH_ZDOTDIR: userZdot,
          ZDOTDIR: integrationDir,
        },
      });
      expect(result.status).toBe(0);
      const [pathLine, whichLine] = (result.stdout ?? "").trim().split("\n");
      expect(pathLine?.split(delimiter)[0]).toBe(binDir);
      expect(whichLine).toBe(join(binDir, "figma"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasZsh)("re-asserts mcp-cli PATH after interactive .zshrc overwrites PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-mcp-cli-zshrc-"));
    try {
      const paseoHome = join(root, "home");
      const binDir = mcpCliBinDir(paseoHome);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "figma"), "#!/bin/sh\necho ok\n");
      chmodSync(join(binDir, "figma"), 0o755);

      const userZdot = join(root, "user-zdot");
      mkdirSync(userZdot, { recursive: true });
      writeFileSync(join(userZdot, ".zshrc"), 'export PATH="/usr/bin:/bin"\n');

      const integrationDir = join(root, "integration");
      mkdirSync(integrationDir, { recursive: true });
      copyFileSync(zshenvSource, join(integrationDir, ".zshenv"));
      copyFileSync(integrationSource, join(integrationDir, "paseo-integration.zsh"));

      // Interactive so .zshrc runs; -c still exits after the command.
      const result = spawnSync(
        "zsh",
        ["-i", "-c", '_paseo_ensure_mcp_cli_path; print -r -- "$PATH"; command -v figma'],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            PATH: [binDir, "/usr/bin", "/bin"].join(delimiter),
            PASEO_MCP_CLI_BIN: binDir,
            PASEO_ZSH_ZDOTDIR: userZdot,
            ZDOTDIR: integrationDir,
          },
        },
      );
      expect(result.status).toBe(0);
      const lines = (result.stdout ?? "")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      const pathLine = lines.find((line) => line.includes(binDir) || line.startsWith("/"));
      const whichLine = lines[lines.length - 1];
      expect(pathLine?.split(delimiter)[0]).toBe(binDir);
      expect(whichLine).toBe(join(binDir, "figma"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
