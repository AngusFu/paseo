import { spawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";

const THEME_CHOICES = ["auto", "generic", "kb-audit", "mr-review", "plan"] as const;

export interface MarkdownCommandOptions {
  template?: string;
  out?: string;
  stdout?: boolean;
  print?: boolean;
  backlink?: string;
  /** Set when callers pass an explicit noCache boolean. */
  noCache?: boolean;
  /**
   * Commander maps `--no-cache` onto `{ cache: false }` (negation of a virtual
   * `--cache` option). Treat `cache === false` as --no-cache.
   */
  cache?: boolean;
  clear?: boolean;
  clearAll?: boolean;
  cacheDir?: boolean;
  lsCache?: boolean;
  serve?: boolean;
  port?: string;
}

/** Commander turns `--no-cache` into `{ cache: false }`; normalize both shapes. */
export function wantsNoCache(options: MarkdownCommandOptions): boolean {
  return options.noCache === true || options.cache === false;
}

export interface MarkdownRuntime {
  spawn: typeof spawn;
  env: NodeJS.ProcessEnv;
  which: (bin: string) => string | undefined;
  existsSync: typeof existsSync;
  accessSync: typeof accessSync;
  resolveScriptPath: () => string;
}

function defaultWhich(bin: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function defaultRuntime(): MarkdownRuntime {
  return {
    spawn,
    env: process.env,
    which: defaultWhich,
    existsSync,
    accessSync,
    resolveScriptPath: resolveMarkdownRenderScript,
  };
}

/** Prefer the real filesystem path when the CLI is packed inside Electron's app.asar. */
export function preferUnpackedAsarPath(filePath: string): string {
  if (!filePath.includes(".asar")) return filePath;
  const unpacked = filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
  return existsSync(unpacked) ? unpacked : filePath;
}

/** `dist/commands/markdown.js` and `src/commands/markdown.ts` both sit two levels above `tools/`. */
export function resolveMarkdownRenderScript(fromUrl: string = import.meta.url): string {
  const script = join(
    dirname(fileURLToPath(fromUrl)),
    "..",
    "..",
    "tools",
    "markdown",
    "render.py",
  );
  return preferUnpackedAsarPath(script);
}

export function resolveUvBinary(
  runtime: Pick<MarkdownRuntime, "which" | "existsSync" | "env">,
): string {
  const fromPath = runtime.which("uv");
  if (fromPath) return fromPath;

  const home = runtime.env.HOME || homedir();
  for (const candidate of [
    join(home, ".local", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ]) {
    if (runtime.existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      "paseo markdown requires uv (https://docs.astral.sh/uv/).",
      "Install: curl -LsSf https://astral.sh/uv/install.sh | sh",
      "Then ensure ~/.local/bin is on PATH.",
    ].join("\n"),
  );
}

export function buildMarkdownArgv(
  md: string | undefined,
  options: MarkdownCommandOptions,
): string[] {
  const args: string[] = [];
  if (options.serve) args.push("--serve");
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.cacheDir) args.push("--cache-dir");
  if (options.lsCache) args.push("--ls-cache");
  if (options.clearAll) args.push("--clear-all");
  if (options.clear) args.push("--clear");
  if (wantsNoCache(options)) args.push("--no-cache");
  if (options.template && options.template !== "auto") {
    args.push("--template", options.template);
  }
  if (options.out) args.push("--out", options.out);
  if (options.stdout) args.push("--stdout");
  if (options.print) args.push("--print");
  if (options.backlink) args.push("--backlink", options.backlink);
  if (md) args.push(md);
  return args;
}

export async function runMarkdownCommand(
  md: string | undefined,
  options: MarkdownCommandOptions,
  runtime: MarkdownRuntime = defaultRuntime(),
): Promise<void> {
  const script = runtime.resolveScriptPath();
  if (!runtime.existsSync(script)) {
    throw new Error(`paseo markdown renderer missing at ${script}`);
  }

  const uv = resolveUvBinary(runtime);
  const args = ["run", "--script", script, ...buildMarkdownArgv(md, options)];
  const spawnOpts: SpawnOptions = {
    stdio: "inherit",
    env: runtime.env,
  };

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = runtime.spawn(uv, args, spawnOpts);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

const MARKDOWN_HELP_EXAMPLES = `
Examples:
  paseo markdown notes.md
  paseo markdown notes.md --print
  paseo markdown notes.md --no-cache
  paseo markdown notes.md --clear
  paseo markdown --clear-all
  paseo markdown --cache-dir
  paseo markdown --ls-cache
  paseo markdown --serve
`;

function hasMarkdownUtilityFlag(options: MarkdownCommandOptions): boolean {
  return Boolean(
    options.serve ||
    options.clearAll ||
    options.clear ||
    options.cacheDir ||
    options.lsCache ||
    options.stdout ||
    options.out ||
    wantsNoCache(options),
  );
}

export function createMarkdownCommand(): Command {
  const command = new Command("markdown")
    .description("Render markdown to styled standalone HTML (md = archive, html = derived view)")
    .argument("[md]", "Markdown file path")
    .addOption(
      new Option("--template <name>", "Theme preset").choices([...THEME_CHOICES]).default("auto"),
    )
    .option("--out <path>", "Write HTML here instead of the cache dir")
    .option("--stdout", "Write HTML to stdout")
    .option("--print", "Print output path only, do not open")
    .option("--backlink <url>", "Header back-link URL")
    .option("--no-cache", "Write a temp HTML instead of the stable cache file")
    .option("--clear", "Delete the cache entry for <md> and exit")
    .option("--clear-all", "Delete every cached HTML under the cache dir")
    .option("--cache-dir", "Print the cache directory and exit")
    .option("--ls-cache", "List cached HTML files and exit")
    .option("--serve", "Run the localhost render server")
    .option("--port <port>", "Serve port (default: 4490)")
    .addHelpText("after", MARKDOWN_HELP_EXAMPLES)
    .action(async (md: string | undefined, options: MarkdownCommandOptions, cmd: Command) => {
      // `paseo markdown help` / bare `paseo markdown` → show help (not treat "help" as a path).
      if (md === "help" || (!md && !hasMarkdownUtilityFlag(options))) {
        cmd.outputHelp();
        return;
      }
      try {
        await runMarkdownCommand(md, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
      }
    });

  return command;
}
