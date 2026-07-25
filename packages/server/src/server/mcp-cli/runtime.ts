import { access, constants, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { McpCliRuntimeStatus } from "@getpaseo/protocol/mcp-cli/types";
import { mcpCliPythonPath, mcpCliRoot, mcpCliRunnerPath, mcpCliVenvDir } from "./paths.js";

const BUNDLED_RUNNER = join(dirname(fileURLToPath(import.meta.url)), "assets", "fastmcp-cli.py");

function platformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

function resolveVenvState(
  venvOk: boolean,
  fastmcpOk: boolean,
): McpCliRuntimeStatus["venv"]["state"] {
  if (venvOk && fastmcpOk) {
    return "present";
  }
  if (venvOk) {
    return "error";
  }
  return "missing";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(bin: string): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n")[0]?.trim();
      resolve(code === 0 && line ? line : null);
    });
    child.on("error", () => resolve(null));
  });
}

async function runCommand(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options?.env ?? process.env,
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function getMcpCliRuntimeStatus(paseoHome: string): Promise<McpCliRuntimeStatus> {
  const supported = platformSupported();
  if (!supported) {
    return {
      platformSupported: false,
      platform: process.platform,
      uv: { state: "unsupported", path: null, message: "macOS/Linux only" },
      venv: { state: "unsupported", path: null },
      runner: { state: "unsupported", path: null },
      ready: false,
      message: "FastMCP CLI requires macOS or Linux on the daemon host.",
    };
  }

  const uvPath = await which("uv");
  const venvPython = mcpCliPythonPath(paseoHome);
  const runnerPath = mcpCliRunnerPath(paseoHome);
  const venvOk = await pathExists(venvPython);
  const runnerOk = await pathExists(runnerPath);

  let fastmcpOk = false;
  if (venvOk) {
    const probe = await runCommand(venvPython, ["-c", "import fastmcp"]);
    fastmcpOk = probe.code === 0;
  }

  const ready = Boolean(uvPath) && venvOk && fastmcpOk && runnerOk;
  return {
    platformSupported: true,
    platform: process.platform,
    uv: {
      state: uvPath ? "present" : "missing",
      path: uvPath,
      message: uvPath
        ? null
        : "uv not on PATH (Install may place uv under ~/.local/bin — launchers stay in $PASEO_HOME/mcp-cli/bin)",
    },
    venv: {
      state: resolveVenvState(venvOk, fastmcpOk),
      path: venvOk ? mcpCliVenvDir(paseoHome) : null,
      message: venvOk && !fastmcpOk ? "venv exists but fastmcp is not importable" : null,
    },
    runner: {
      state: runnerOk ? "present" : "missing",
      path: runnerOk ? runnerPath : null,
    },
    ready,
    message: ready ? "Ready" : "Runtime not installed",
  };
}

export async function installMcpCliRuntime(paseoHome: string): Promise<McpCliRuntimeStatus> {
  if (!platformSupported()) {
    return getMcpCliRuntimeStatus(paseoHome);
  }

  await mkdir(mcpCliRoot(paseoHome), { recursive: true });

  let uvPath = await which("uv");
  if (!uvPath) {
    // Official installer may write to ~/.local/bin — that is uv itself, not our launchers.
    const install = await runCommand("bash", [
      "-lc",
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
    ]);
    if (install.code !== 0) {
      const status = await getMcpCliRuntimeStatus(paseoHome);
      return {
        ...status,
        ready: false,
        message: `Failed to install uv: ${install.stderr.trim() || install.stdout.trim()}`,
        uv: {
          state: "error",
          path: null,
          message: install.stderr.trim() || install.stdout.trim() || "uv install failed",
        },
      };
    }
    // Refresh PATH for this process lookup
    const localBin = join(process.env.HOME ?? "", ".local", "bin");
    process.env.PATH = `${localBin}:${process.env.PATH ?? ""}`;
    uvPath = await which("uv");
  }

  if (!uvPath) {
    const status = await getMcpCliRuntimeStatus(paseoHome);
    return {
      ...status,
      ready: false,
      message: "uv still not found after install",
    };
  }

  const venvDir = mcpCliVenvDir(paseoHome);
  if (!(await pathExists(mcpCliPythonPath(paseoHome)))) {
    const venv = await runCommand(uvPath, ["venv", venvDir]);
    if (venv.code !== 0) {
      throw new Error(`uv venv failed: ${venv.stderr || venv.stdout}`);
    }
  }

  const pip = await runCommand(uvPath, [
    "pip",
    "install",
    "--python",
    mcpCliPythonPath(paseoHome),
    "fastmcp",
    "py-key-value-aio[disk]",
  ]);
  if (pip.code !== 0) {
    throw new Error(`uv pip install failed: ${pip.stderr || pip.stdout}`);
  }

  if (!(await pathExists(BUNDLED_RUNNER))) {
    throw new Error(`Bundled runner missing at ${BUNDLED_RUNNER}`);
  }
  await copyFile(BUNDLED_RUNNER, mcpCliRunnerPath(paseoHome));
  // Marker so status can show install completed once.
  await writeFile(
    join(mcpCliRoot(paseoHome), "runtime.json"),
    `${JSON.stringify({ installedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  return getMcpCliRuntimeStatus(paseoHome);
}
