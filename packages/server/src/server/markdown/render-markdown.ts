import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execCommand } from "../../utils/spawn.js";

const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@getpaseo/cli/bin/paseo";
const THEME_CHOICES = ["auto", "generic", "kb-audit", "mr-review", "plan"] as const;

export type MarkdownTheme = (typeof THEME_CHOICES)[number];

export interface RenderMarkdownInput {
  path?: string;
  open?: boolean;
  template?: MarkdownTheme;
  noCache?: boolean;
  out?: string;
  clear?: boolean;
  clearAll?: boolean;
}

export interface RenderMarkdownResult {
  htmlPath: string | null;
  opened: boolean;
  cleared: string | null;
  message: string;
}

export interface RenderMarkdownRuntime {
  resolveRenderScript: () => string;
  resolveUv: () => string;
  exec: typeof execCommand;
  env?: NodeJS.ProcessEnv;
}

/** Prefer the real filesystem path when the CLI is packed inside Electron's app.asar. */
export function preferUnpackedAsarPath(filePath: string): string {
  if (!filePath.includes(".asar")) return filePath;
  const unpacked = filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
  return existsSync(unpacked) ? unpacked : filePath;
}

export function resolveMarkdownRenderScript(): string {
  let cliBin: string;
  try {
    cliBin = require.resolve(PASEO_CLI_BIN_ENTRY);
  } catch {
    throw new Error(
      "render_markdown requires @getpaseo/cli next to the daemon (tools/markdown/render.py).",
    );
  }
  // bin/paseo -> package root -> tools/markdown/render.py
  const script = join(dirname(dirname(cliBin)), "tools", "markdown", "render.py");
  const resolved = preferUnpackedAsarPath(script);
  if (!existsSync(resolved)) {
    throw new Error(`paseo markdown renderer missing at ${resolved}`);
  }
  return resolved;
}

export function resolveUvBinary(env: NodeJS.ProcessEnv = process.env): string {
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "uv.exe" : "uv");
    if (existsSync(candidate)) return candidate;
  }

  const home = env.HOME || env.USERPROFILE || homedir();
  for (const candidate of [
    join(home, ".local", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      "render_markdown requires uv (https://docs.astral.sh/uv/).",
      "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
      "Then ensure ~/.local/bin is on PATH for the daemon.",
    ].join("\n"),
  );
}

export function buildRenderMarkdownArgv(input: RenderMarkdownInput): string[] {
  const args: string[] = [];
  if (input.clearAll) args.push("--clear-all");
  if (input.clear) args.push("--clear");
  if (input.noCache) args.push("--no-cache");
  if (input.template && input.template !== "auto") {
    args.push("--template", input.template);
  }
  if (input.out) args.push("--out", input.out);
  // MCP/daemon callers always want the path printed; open is controlled separately.
  if (!input.clear && !input.clearAll) {
    if (input.open === false) {
      args.push("--print");
    }
  }
  if (input.path) args.push(input.path);
  return args;
}

function defaultRuntime(): RenderMarkdownRuntime {
  return {
    resolveRenderScript: resolveMarkdownRenderScript,
    resolveUv: () => resolveUvBinary(),
    exec: execCommand,
    env: process.env,
  };
}

export async function renderMarkdown(
  input: RenderMarkdownInput,
  runtime: RenderMarkdownRuntime = defaultRuntime(),
): Promise<RenderMarkdownResult> {
  if (input.clearAll) {
    const { stdout } = await runRenderer(buildRenderMarkdownArgv({ clearAll: true }), runtime);
    return {
      htmlPath: null,
      opened: false,
      cleared: "all",
      message: stdout.trim() || "cleared cache",
    };
  }

  if (input.clear) {
    if (!input.path?.trim()) {
      throw new Error("path is required when clear is true");
    }
    const { stdout } = await runRenderer(
      buildRenderMarkdownArgv({ path: input.path, clear: true }),
      runtime,
    );
    return {
      htmlPath: null,
      opened: false,
      cleared: input.path,
      message: stdout.trim() || `cleared cache for ${input.path}`,
    };
  }

  if (!input.path?.trim()) {
    throw new Error("path is required");
  }

  const open = input.open !== false;
  const { stdout } = await runRenderer(
    buildRenderMarkdownArgv({
      path: input.path,
      open,
      template: input.template,
      noCache: input.noCache,
      out: input.out,
    }),
    runtime,
  );

  // When open is true the renderer prints the path then opens; stdout is just the path.
  const htmlPath =
    stdout
      .trim()
      .split("\n")
      .findLast((line) => line.length > 0) ?? "";
  if (!htmlPath) {
    throw new Error("paseo markdown produced no output path");
  }

  return {
    htmlPath,
    opened: open,
    cleared: null,
    message: open ? `opened ${htmlPath}` : htmlPath,
  };
}

async function runRenderer(
  argv: string[],
  runtime: RenderMarkdownRuntime,
): Promise<{ stdout: string; stderr: string }> {
  const script = runtime.resolveRenderScript();
  const uv = runtime.resolveUv();
  try {
    return await runtime.exec(uv, ["run", "--script", script, ...argv], {
      envMode: "external",
      env: runtime.env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim();
    throw new Error(detail || "paseo markdown failed", { cause: error });
  }
}
