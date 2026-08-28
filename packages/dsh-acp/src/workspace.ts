import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const WORKSPACE_UNIT_VERSION = 2;

export interface DshWorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DshWorkspaceDocument {
  unit: { name: "workspace"; version: number };
  global: {
    initialized: boolean;
    workspaceIds: string[];
    archivedSessionIds?: string[];
  };
  tables: { workspaces: Record<string, DshWorkspaceRecord> };
}

export interface DshWorkspaceRegistry {
  ensure(cwd: string): Promise<void>;
  attach(input: { cwd: string; sessionId: string }): Promise<void>;
}

export class FileDshWorkspaceRegistry implements DshWorkspaceRegistry {
  constructor(private readonly dshHome: string) {}

  async ensure(cwd: string): Promise<void> {
    ensureDshWorkspace({ cwd, dshHome: this.dshHome });
  }

  async attach(input: { cwd: string; sessionId: string }): Promise<void> {
    attachDshSessionToWorkspace({ ...input, dshHome: this.dshHome });
  }
}

export class LiveDshWorkspaceRegistry implements DshWorkspaceRegistry {
  private baseUrl: string | null | undefined;

  constructor(private readonly dshHome: string) {}

  async ensure(cwd: string): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      ensureDshWorkspace({ cwd, dshHome: this.dshHome });
      return;
    }
    await callDshWeb(baseUrl, "workspace.create", { path: cwd });
  }

  async attach(input: { cwd: string; sessionId: string }): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      attachDshSessionToWorkspace({ ...input, dshHome: this.dshHome });
      return;
    }
    await retry(async () => {
      await callDshWeb(baseUrl, "dsh-acp.workspace.attach-session", input);
    });
  }

  private async resolveBaseUrl(): Promise<string | null> {
    if (this.baseUrl !== undefined) {
      return this.baseUrl;
    }
    for (const candidate of dshWebCandidates()) {
      try {
        await callDshWeb(candidate, "workspace.list", {}, 800);
        this.baseUrl = candidate;
        return candidate;
      } catch {
        // Continue to the next known DSH Web endpoint.
      }
    }
    this.baseUrl = null;
    return null;
  }
}

export function ensureDshWorkspace(input: { cwd: string; dshHome: string }): {
  workspaceId: string;
  created: boolean;
} {
  const cwd = canonicalizePath(input.cwd);
  const document = readDshWorkspaceDocument(input.dshHome);
  const existing = Object.entries(document.tables.workspaces).find(
    ([, workspace]) => canonicalizePath(workspace.path) === cwd,
  );
  if (existing) {
    return { workspaceId: existing[0], created: false };
  }
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  document.tables.workspaces[workspaceId] = {
    path: cwd,
    title: basename(cwd) || "workspace",
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  document.global.workspaceIds.unshift(workspaceId);
  writeDshWorkspaceDocument(input.dshHome, document);
  return { workspaceId, created: true };
}

export function attachDshSessionToWorkspace(input: {
  cwd: string;
  sessionId: string;
  dshHome: string;
}): { workspaceId: string; created: boolean } {
  const cwd = canonicalizePath(input.cwd);
  const document = readDshWorkspaceDocument(input.dshHome);
  const existing = Object.entries(document.tables.workspaces).find(
    ([, workspace]) => canonicalizePath(workspace.path) === cwd,
  );
  const now = new Date().toISOString();

  if (existing) {
    const [workspaceId, workspace] = existing;
    if (!workspace.sessionIds.includes(input.sessionId)) {
      workspace.sessionIds = [input.sessionId, ...workspace.sessionIds];
      workspace.updatedAt = now;
      writeDshWorkspaceDocument(input.dshHome, document);
    }
    return { workspaceId, created: false };
  }

  const created = ensureDshWorkspace({ cwd, dshHome: input.dshHome });
  const refreshed = readDshWorkspaceDocument(input.dshHome);
  const workspace = refreshed.tables.workspaces[created.workspaceId];
  if (!workspace) {
    throw new Error(`DSH workspace ${created.workspaceId} disappeared during creation`);
  }
  workspace.sessionIds = [input.sessionId];
  workspace.updatedAt = now;
  writeDshWorkspaceDocument(input.dshHome, refreshed);
  return created;
}

export function readDshWorkspaceDocument(dshHome: string): DshWorkspaceDocument {
  const path = workspaceStoragePath(dshHome);
  if (!existsSync(path)) {
    return emptyWorkspaceDocument();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DshWorkspaceDocument>;
    if (
      parsed.unit?.name !== "workspace" ||
      !parsed.tables?.workspaces ||
      typeof parsed.tables.workspaces !== "object"
    ) {
      return emptyWorkspaceDocument();
    }
    return {
      unit: { name: "workspace", version: parsed.unit.version ?? WORKSPACE_UNIT_VERSION },
      global: {
        initialized: parsed.global?.initialized ?? true,
        workspaceIds: Array.isArray(parsed.global?.workspaceIds) ? parsed.global.workspaceIds : [],
        archivedSessionIds: Array.isArray(parsed.global?.archivedSessionIds)
          ? parsed.global.archivedSessionIds
          : [],
      },
      tables: { workspaces: parsed.tables.workspaces },
    };
  } catch {
    return emptyWorkspaceDocument();
  }
}

function writeDshWorkspaceDocument(dshHome: string, document: DshWorkspaceDocument): void {
  const target = workspaceStoragePath(dshHome);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function workspaceStoragePath(dshHome: string): string {
  return join(dshHome, "storages", "workspace.json");
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function emptyWorkspaceDocument(): DshWorkspaceDocument {
  return {
    unit: { name: "workspace", version: WORKSPACE_UNIT_VERSION },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  };
}

function dshWebCandidates(): string[] {
  const candidates: string[] = [];
  for (const name of ["DSH_WEB_URL", "DSH_WS_URL"] as const) {
    const value = process.env[name]?.trim();
    if (value) {
      candidates.push(value.replace(/\/$/, ""));
    }
  }
  if (process.platform === "darwin") {
    try {
      const settings = JSON.parse(
        readFileSync(
          join(homedir(), "Library", "Application Support", "Paseo", "desktop-settings.json"),
          "utf8",
        ),
      ) as { settings?: { deepseekHarness?: { port?: unknown } } };
      const port = settings.settings?.deepseekHarness?.port;
      if (typeof port === "number" && Number.isInteger(port)) {
        candidates.push(`http://127.0.0.1:${port}`);
      }
    } catch {
      // Desktop settings are optional.
    }
  }
  candidates.push("http://127.0.0.1:3080");
  return [...new Set(candidates)];
}

async function callDshWeb(
  baseUrl: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`DSH Web ${method} returned HTTP ${response.status}`);
  }
  const envelope = (await response.json()) as {
    result?: { ok?: boolean; value?: Record<string, unknown>; error?: { message?: string } };
  };
  if (!envelope.result?.ok) {
    throw new Error(envelope.result?.error?.message ?? `DSH Web ${method} failed`);
  }
  return envelope.result.value ?? {};
}

async function retry(operation: () => Promise<void>): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
    }
  }
  throw latestError;
}
