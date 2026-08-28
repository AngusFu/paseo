import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { type DshLocationOptions, resolveDshHome } from "./dsh-home.js";

const WORKSPACE_STORAGE_FILE = "workspace.json";
const WORKSPACE_UNIT_VERSION = 2;

export interface DshWorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DshWorkspaceDocument {
  unit: {
    name: "workspace";
    version: number;
  };
  global: {
    initialized: boolean;
    workspaceIds: string[];
    archivedSessionIds?: string[];
  };
  tables: {
    workspaces: Record<string, DshWorkspaceRecord>;
  };
}

export function resolveDshWorkspaceStoragePath(options?: DshLocationOptions): string {
  return join(resolveDshHome(options), "storages", WORKSPACE_STORAGE_FILE);
}

function canonicalizePath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function createDefaultDocument(): DshWorkspaceDocument {
  return {
    unit: {
      name: "workspace",
      version: WORKSPACE_UNIT_VERSION,
    },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
    },
    tables: {
      workspaces: {},
    },
  };
}

export function readDshWorkspaceDocument(options?: DshLocationOptions): DshWorkspaceDocument {
  const filePath = resolveDshWorkspaceStoragePath(options);
  if (!existsSync(filePath)) {
    return createDefaultDocument();
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DshWorkspaceDocument>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.unit?.name !== "workspace" ||
      typeof parsed.tables?.workspaces !== "object"
    ) {
      return createDefaultDocument();
    }

    return {
      unit: {
        name: "workspace",
        version: parsed.unit.version ?? WORKSPACE_UNIT_VERSION,
      },
      global: {
        initialized: parsed.global?.initialized ?? true,
        workspaceIds: Array.isArray(parsed.global?.workspaceIds) ? parsed.global.workspaceIds : [],
        archivedSessionIds: Array.isArray(parsed.global?.archivedSessionIds)
          ? parsed.global.archivedSessionIds
          : [],
      },
      tables: {
        workspaces: parsed.tables.workspaces ?? {},
      },
    };
  } catch {
    return createDefaultDocument();
  }
}

export function writeDshWorkspaceDocument(
  document: DshWorkspaceDocument,
  options?: DshLocationOptions,
): void {
  const targetPath = resolveDshWorkspaceStoragePath(options);
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  const tempPath = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(tempPath, targetPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export interface AttachDshSessionInput {
  cwd: string;
  sessionId: string;
  title?: string;
  options?: DshLocationOptions;
}

export interface AttachDshSessionResult {
  workspaceId: string;
  created: boolean;
}

/**
 * Attaches a session to its corresponding workspace in `$DSH_HOME/storages/workspace.json`.
 * If a workspace matching the canonical `cwd` already exists, prepends the `sessionId`.
 * Otherwise, creates a new workspace record so DSH Web UI groups it cleanly.
 */
export function attachDshSessionToWorkspace(input: AttachDshSessionInput): AttachDshSessionResult {
  const normalizedCwd = canonicalizePath(input.cwd);
  const doc = readDshWorkspaceDocument(input.options);
  const workspaces = doc.tables.workspaces;
  const now = new Date().toISOString();

  let matchedWorkspaceId: string | null = null;
  for (const [id, ws] of Object.entries(workspaces)) {
    if (ws && canonicalizePath(ws.path) === normalizedCwd) {
      matchedWorkspaceId = id;
      break;
    }
  }

  if (matchedWorkspaceId) {
    const ws = workspaces[matchedWorkspaceId];
    if (ws) {
      if (!ws.sessionIds.includes(input.sessionId)) {
        ws.sessionIds = [input.sessionId, ...ws.sessionIds];
        ws.updatedAt = now;
      }
    }
    writeDshWorkspaceDocument(doc, input.options);
    return { workspaceId: matchedWorkspaceId, created: false };
  }

  const newWorkspaceId = randomUUID();
  const title = input.title?.trim() || basename(normalizedCwd) || "workspace";

  workspaces[newWorkspaceId] = {
    path: normalizedCwd,
    title,
    sessionIds: [input.sessionId],
    createdAt: now,
    updatedAt: now,
  };

  if (!doc.global.workspaceIds.includes(newWorkspaceId)) {
    doc.global.workspaceIds.push(newWorkspaceId);
  }

  writeDshWorkspaceDocument(doc, input.options);
  return { workspaceId: newWorkspaceId, created: true };
}
