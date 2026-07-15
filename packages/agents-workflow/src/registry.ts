/**
 * Workflow registry — resolve a workflow by name or path.
 *
 * Search order (highest precedence first):
 *   1. explicit file path (if the argument looks like a path that exists)
 *   2. project dir:   ./workflows/<name>.flow.js
 *   3. user dir:      ~/.flowkit/workflows/<name>.flow.js
 *   4. builtin dir:   <pkg>/workflows/builtin/<name>.flow.js
 *
 * builtin/ holds the 10 Anthropic Claude-Workflow flows, all inline JSON
 * Schema. A path-invoked flow (an arg with a `/` or a known extension) is read
 * verbatim, so a flow living OUTSIDE these dirs (e.g. a host repo's own
 * .claude/workflows/) still runs by path.
 *
 * A "workflow file" is any text beginning with `export const meta = {...}`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { extractMeta, type WorkflowMeta } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// one extension maps to a workflow file: .flow.js (Claude-Workflow flow,
// inline JSON Schema). a path-invoked file (with a `/` or `.js`) still runs
// regardless of extension.
const FLOW_EXTS = [".flow.js"];

export interface ResolvedWorkflow {
  name: string;
  meta: WorkflowMeta;
  source: string;
  path: string;
  origin: "path" | "project" | "user" | "builtin";
}

export interface RegistryDirs {
  project?: string; // defaults to <cwd>/workflows
  user?: string; // defaults to ~/.flowkit/workflows
  builtin?: string; // defaults to <pkg>/workflows/builtin
}

function defaultDirs(): Required<RegistryDirs> {
  return {
    project: path.join(process.cwd(), "workflows"),
    user: path.join(os.homedir(), ".flowkit", "workflows"),
    // src/registry.{ts,js} -> ../workflows/builtin (agents-workflow layout: workflows/
    // is a sibling of src/, one hop up whether from src/ or dist/).
    builtin: path.join(__dirname, "..", "workflows", "builtin"),
  };
}

function isPathLike(s: string): boolean {
  return (
    s.includes("/") ||
    FLOW_EXTS.some((ext) => s.endsWith(ext)) ||
    s.endsWith(".js") ||
    s.endsWith(".ts")
  );
}

// strip whichever known flow extension the file has, for the meta.name fallback.
function stripFlowExt(file: string): string {
  const base = path.basename(file);
  for (const ext of FLOW_EXTS) {
    if (base.endsWith(ext)) return base.slice(0, -ext.length);
  }
  return base;
}

function readWorkflow(file: string, origin: ResolvedWorkflow["origin"]): ResolvedWorkflow {
  const source = fs.readFileSync(file, "utf-8");
  const { meta } = extractMeta(source);
  const name = (meta.name as string) ?? stripFlowExt(file);
  return { name, meta, source, path: file, origin };
}

/**
 * Resolve a workflow by name or path. Throws with a helpful message listing
 * builtin names when nothing matches.
 */
export function resolveWorkflow(nameOrPath: string, dirs: RegistryDirs = {}): ResolvedWorkflow {
  const d = { ...defaultDirs(), ...dirs };

  // 1. explicit path
  if (isPathLike(nameOrPath)) {
    const abs = path.resolve(nameOrPath);
    if (fs.existsSync(abs)) return readWorkflow(abs, "path");
  }

  // 2/3/4. by name — each dir tried with both known extensions.
  const dirOrigins: Array<[string, ResolvedWorkflow["origin"]]> = [
    [d.project, "project"],
    [d.user, "user"],
    [d.builtin, "builtin"],
  ];
  for (const [dir, origin] of dirOrigins) {
    for (const ext of FLOW_EXTS) {
      const file = path.join(dir, nameOrPath + ext);
      if (fs.existsSync(file)) return readWorkflow(file, origin);
    }
  }

  const available = listWorkflows(dirs)
    .map((w) => w.name)
    .join(", ");
  throw new Error(
    `Workflow "${nameOrPath}" not found (looked in project/user/builtin). ` +
      `Available builtin: ${available || "(none)"}.`,
  );
}

/** List all discoverable workflows (builtin + user + project), deduped by name. */
export function listWorkflows(dirs: RegistryDirs = {}): ResolvedWorkflow[] {
  const d = { ...defaultDirs(), ...dirs };
  const byName = new Map<string, ResolvedWorkflow>();
  const scan = (dir: string, origin: ResolvedWorkflow["origin"]): void => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!FLOW_EXTS.some((ext) => f.endsWith(ext))) continue;
      try {
        const wf = readWorkflow(path.join(dir, f), origin);
        if (!byName.has(wf.name)) byName.set(wf.name, wf);
      } catch {
        /* skip unparseable */
      }
    }
  };
  // precedence: project > user > builtin
  scan(d.project, "project");
  scan(d.user, "user");
  scan(d.builtin, "builtin");
  return [...byName.values()];
}
