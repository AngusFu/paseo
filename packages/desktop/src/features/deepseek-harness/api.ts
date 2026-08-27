import { randomUUID } from "node:crypto";
import { realpath as fsRealpath } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DshRpcEnvelope {
  type: string;
  result?: {
    ok?: boolean;
    value?: unknown;
    error?: { message?: string; code?: string };
  };
}

export function normalizeBaseUrl(url: string): string {
  return String(url).replace(/\/$/, "");
}

export async function dshRpc(
  baseUrl: string,
  method: string,
  payload: Record<string, unknown> = {},
  options?: { timeoutMs?: number },
): Promise<DshRpcEnvelope> {
  const body = {
    type: "client-request",
    rpcId: randomUUID(),
    method,
    payload,
  };
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek Harness transport failure for ${method}: HTTP ${res.status}`);
  }
  return (await res.json()) as DshRpcEnvelope;
}

export function unwrapDshResult(envelope: DshRpcEnvelope, label: string): unknown {
  if (!envelope || envelope.type !== "server-response") {
    throw new Error(`${label}: unexpected response shape`);
  }
  if (!envelope.result?.ok) {
    const err = envelope.result?.error;
    const msg = err?.message || JSON.stringify(err || envelope.result);
    const code = err?.code ? ` [${err.code}]` : "";
    throw new Error(`${label} failed${code}: ${msg}`);
  }
  return envelope.result.value;
}

export async function probeDshApi(baseUrl: string): Promise<boolean> {
  try {
    const envelope = await dshRpc(baseUrl, "workspace.list", {}, { timeoutMs: 2_000 });
    return envelope?.type === "server-response" && typeof envelope.result === "object";
  } catch {
    return false;
  }
}

export interface DshWorkspaceRow {
  workspaceId: string;
  path: string;
  title: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asWorkspaceRow(value: unknown): DshWorkspaceRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (!workspaceId || !path) {
    return null;
  }
  return {
    workspaceId,
    path,
    title: typeof value.title === "string" ? value.title : null,
  };
}

async function realpathOrSelf(inputPath: string): Promise<string> {
  try {
    return await fsRealpath(inputPath);
  } catch {
    return inputPath;
  }
}

export async function ensureDshWorkspace(input: {
  baseUrl: string;
  cwd: string;
  title?: string | null;
}): Promise<DshWorkspaceRow> {
  const cwd = input.cwd.trim();
  if (!cwd) {
    throw new Error("DeepSeek Harness workspace requires a non-empty cwd");
  }
  const cwdReal = await realpathOrSelf(cwd);
  const listed = unwrapDshResult(
    await dshRpc(input.baseUrl, "workspace.list", {}),
    "workspace.list",
  );
  const items = isRecord(listed) && Array.isArray(listed.items) ? listed.items : [];
  for (const item of items) {
    const row = asWorkspaceRow(item);
    if (!row) continue;
    const itemReal = await realpathOrSelf(row.path);
    if (itemReal === cwdReal || row.path === cwd) {
      return row;
    }
  }

  const payload: Record<string, unknown> = { path: cwd };
  const title = input.title?.trim();
  if (title) {
    payload.title = title;
  }
  const created = unwrapDshResult(
    await dshRpc(input.baseUrl, "workspace.create", payload),
    "workspace.create",
  );
  const createdRow = asWorkspaceRow(created);
  if (!createdRow) {
    throw new Error("workspace.create returned an unexpected payload");
  }
  return createdRow;
}

export interface DshSessionCreateResult {
  sessionId: string;
}

/** Known DSH permission presets (from `/permission` with empty input). */
export const DSH_PERMISSION_PRESETS = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type DshPermissionPreset = (typeof DSH_PERMISSION_PRESETS)[number];

export function normalizeDshPermissionPreset(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
  const aliases: Record<string, string> = {
    readonly: "read-only",
    "read-only": "read-only",
    read: "read-only",
    "workspace-write": "workspace-write",
    workspacewrite: "workspace-write",
    write: "workspace-write",
    "danger-full-access": "danger-full-access",
    dangerfullaccess: "danger-full-access",
    full: "danger-full-access",
    yolo: "danger-full-access",
  };
  return aliases[lowered] ?? (trimmed.includes("/") ? null : trimmed);
}

/**
 * Create a blank DSH session attached to a workspace. Used so Desktop can
 * open a stable `?sessionId=` embed URL (pin on reload) instead of
 * `?workspaceId=` (which always creates another session on each load).
 */
export async function createDshSession(input: {
  baseUrl: string;
  workspaceId: string;
  sessionId?: string | null;
  agentPreset?: string | null;
}): Promise<DshSessionCreateResult> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    throw new Error("DeepSeek Harness session.create requires workspaceId");
  }
  const payload: Record<string, unknown> = { workspaceId };
  const sessionId = input.sessionId?.trim();
  if (sessionId) {
    payload.sessionId = sessionId;
  }
  const agentPreset = input.agentPreset?.trim();
  if (agentPreset) {
    payload.agentPreset = agentPreset;
  }
  const created = unwrapDshResult(
    await dshRpc(input.baseUrl, "session.create", payload),
    "session.create",
  );
  if (!isRecord(created) || typeof created.sessionId !== "string" || !created.sessionId.trim()) {
    throw new Error("session.create returned an unexpected payload");
  }
  return { sessionId: created.sessionId.trim() };
}

/**
 * Switch a session's permission preset via the host `/permission` command
 * (`commands/execute`). Available: read-only, workspace-write, danger-full-access.
 */
export async function setDshPermissionPreset(input: {
  baseUrl: string;
  sessionId: string;
  permission: string;
}): Promise<{ preset: string; text: string }> {
  const sessionId = input.sessionId.trim();
  const permission = normalizeDshPermissionPreset(input.permission);
  if (!sessionId) {
    throw new Error("DeepSeek Harness permission requires sessionId");
  }
  if (!permission) {
    throw new Error("DeepSeek Harness permission requires a preset name");
  }
  const executed = unwrapDshResult(
    await dshRpc(input.baseUrl, "commands/execute", {
      args: {
        agentId: sessionId,
        line: `/permission ${permission}`,
        images: [],
      },
    }),
    "commands/execute",
  );
  if (!isRecord(executed)) {
    throw new Error("commands/execute returned an unexpected payload");
  }
  const result = isRecord(executed.result) ? executed.result : null;
  const kind = result && typeof result.kind === "string" ? result.kind : null;
  const text = result && typeof result.text === "string" ? result.text : "";
  if (kind === "error") {
    throw new Error(text || `permission preset failed: ${permission}`);
  }
  return { preset: permission, text };
}
