import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { extractMeta } from "@getpaseo/agents-workflow";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "@getpaseo/protocol/workflow/types";

/**
 * Project-local workflow definitions — read-through, never imported.
 *
 * A repo can keep `*.flow.js` scripts in `.paseo/workflows/` (Paseo-native) or
 * `.claude/workflows/` (Claude Code named workflows — same dialect, so they
 * run unchanged). The daemon lists them per-request when a client passes a
 * `cwd`, and resolves `project:<abs file path>` ids by reading the file fresh
 * at dispatch time. The repo file is the single source of truth: edits land
 * via the editor/agents + git, not via the definition-update RPC (project
 * definitions are read-only over the wire — fork to a user definition to
 * edit in the app).
 */
export const PROJECT_WORKFLOW_DIRS = [
  join(".paseo", "workflows"),
  join(".claude", "workflows"),
] as const;

export const PROJECT_DEFINITION_ID_PREFIX = "project:";

// .flow.js is the convention; bare .js is accepted for .claude/workflows
// compatibility. Anything else in those dirs (README.md, assets) is skipped,
// as is a .js file that doesn't carry the `export const meta` marker.
function isFlowFile(name: string): boolean {
  return name.endsWith(".flow.js") || name.endsWith(".js");
}

function fileToDefinition(
  filePath: string,
  source: string,
  mtime: Date,
): WorkflowDefinition | null {
  let name: string;
  let description: string | null;
  try {
    const { meta } = extractMeta(source);
    name = typeof meta.name === "string" && meta.name.length > 0 ? meta.name : baseName(filePath);
    description = typeof meta.description === "string" ? meta.description : null;
  } catch {
    return null; // not a workflow script (or a broken meta) — skip, never throw
  }
  const iso = mtime.toISOString();
  return WorkflowDefinitionSchema.parse({
    id: `${PROJECT_DEFINITION_ID_PREFIX}${filePath}`,
    name,
    description,
    source,
    builtin: false,
    createdAt: iso,
    updatedAt: iso,
    origin: "project",
    sourcePath: filePath,
  });
}

function baseName(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf(sep) + 1);
  return base.replace(/\.flow\.js$|\.js$/, "");
}

/**
 * Scan `<cwd>`'s project workflow dirs and return read-through definitions.
 * `.paseo/workflows` wins a NAME collision with `.claude/workflows` (dir
 * order); two files in one dir keep both entries (distinct paths/ids).
 */
export async function listProjectDefinitions(cwd: string): Promise<WorkflowDefinition[]> {
  const root = resolve(cwd);
  const definitions: WorkflowDefinition[] = [];
  const seenNames = new Set<string>();
  for (const dir of PROJECT_WORKFLOW_DIRS) {
    const dirPath = join(root, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue; // dir absent — normal
    }
    const dirDefinitions: WorkflowDefinition[] = [];
    for (const entry of entries.filter(isFlowFile).sort()) {
      const filePath = join(dirPath, entry);
      try {
        const [source, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
        const definition = fileToDefinition(filePath, source, info.mtime);
        if (definition && !seenNames.has(definition.name.toLowerCase())) {
          dirDefinitions.push(definition);
        }
      } catch {
        /* unreadable file — skip */
      }
    }
    for (const definition of dirDefinitions) {
      seenNames.add(definition.name.toLowerCase());
      definitions.push(definition);
    }
  }
  return definitions;
}

/**
 * Resolve a `project:<abs path>` id by reading the file FRESH — dispatch always
 * runs the current on-disk source. Returns null when the id is not a project
 * id, the path escapes the allowed layout, or the file is gone/not a workflow.
 */
export async function getProjectDefinition(id: string): Promise<WorkflowDefinition | null> {
  if (!id.startsWith(PROJECT_DEFINITION_ID_PREFIX)) {
    return null;
  }
  const filePath = id.slice(PROJECT_DEFINITION_ID_PREFIX.length);
  if (!isProjectWorkflowPath(filePath)) {
    return null;
  }
  try {
    const [source, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    return fileToDefinition(filePath, source, info.mtime);
  } catch {
    return null;
  }
}

/**
 * The id embeds a filesystem path, so gate what the RPC will read: an
 * absolute, normalized path whose parent is a `.paseo/workflows` or
 * `.claude/workflows` directory, with a flow extension. Anything else (`..`
 * traversal, arbitrary files) resolves to null instead of being read.
 */
export function isProjectWorkflowPath(filePath: string): boolean {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    return false;
  }
  if (!isFlowFile(filePath)) {
    return false;
  }
  const parent = filePath.slice(0, filePath.lastIndexOf(sep));
  return PROJECT_WORKFLOW_DIRS.some((dir) => parent.endsWith(sep + dir));
}
