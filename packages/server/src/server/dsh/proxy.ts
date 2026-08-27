import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import path from "node:path";
import type { DshSessionRow, DshStatus } from "@getpaseo/protocol/dsh/types";

const DEFAULT_BASE = "http://127.0.0.1:3080";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Discovery probes must be short — Desktop leaves many loopback listeners. */
const PROBE_TIMEOUT_MS = 800;

const PERMISSION_ALIASES: Record<string, string> = {
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

const SHORT_ID_RE = /^[0-9a-f]{6,8}/i;

interface DshRpcEnvelope {
  type?: string;
  result?: {
    ok?: boolean;
    value?: unknown;
    error?: { message?: string; code?: string };
  };
}

interface RawSessionListItem {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  parentSessionId?: string | null;
  origin?: string | null;
  cwd?: string | null;
  agentPreset?: string | null;
  projections?: {
    values?: {
      title?: string;
      sessionStats?: { turns?: number };
      contextTimeline?: { model?: string; provider?: string };
      pendingInteraction?: unknown;
    };
  };
}

function normalizeBase(url: string): string {
  return String(url).replace(/\/$/, "");
}

function listPaseoDesktopHarnessBases(): string[] {
  const homes: string[] = [];
  const home = homedir();
  if (process.platform === "darwin") {
    homes.push(path.join(home, "Library", "Application Support", "Paseo"));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) homes.push(path.join(appData, "Paseo"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    homes.push(xdg ? path.join(xdg, "Paseo") : path.join(home, ".config", "Paseo"));
  }
  const override = process.env.PASEO_DESKTOP_USER_DATA?.trim();
  if (override) homes.unshift(override);

  const bases: string[] = [];
  for (const dir of homes) {
    try {
      const raw = readFileSync(path.join(dir, "desktop-settings.json"), "utf8");
      const json = JSON.parse(raw) as { deepseekHarness?: { port?: unknown } };
      const port = json?.deepseekHarness?.port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
        bases.push(`http://127.0.0.1:${port}`);
      }
    } catch {
      // missing / unreadable
    }
  }
  return bases;
}

function listLoopbackHttpBases(): string[] {
  try {
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const ports = new Set<number>();
    for (const m of out.matchAll(/127\.0\.0\.1:(\d+)/g)) {
      ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b).map((p) => `http://127.0.0.1:${p}`);
  } catch {
    return [];
  }
}

async function dshRpc(
  base: string,
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
  const res = await fetch(`${normalizeBase(base)}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`transport failure for ${method}: HTTP ${res.status}`);
  }
  return (await res.json()) as DshRpcEnvelope;
}

function unwrap<T>(result: DshRpcEnvelope, label: string): T {
  if (!result || result.type !== "server-response") {
    throw new Error(`${label}: unexpected response shape`);
  }
  if (!result.result?.ok) {
    const err = result.result?.error;
    const msg = err?.message || JSON.stringify(err || result.result);
    const code = err?.code ? ` [${err.code}]` : "";
    throw new Error(`${label} failed${code}: ${msg}`);
  }
  return result.result.value as T;
}

async function probe(base: string): Promise<boolean> {
  try {
    const res = await dshRpc(base, "workspace.list", {}, { timeoutMs: PROBE_TIMEOUT_MS });
    return res?.type === "server-response" && typeof res?.result === "object";
  } catch {
    return false;
  }
}

async function probeFirstLive(bases: string[]): Promise<string | null> {
  if (bases.length === 0) return null;
  return await new Promise((resolve) => {
    let pending = bases.length;
    let settled = false;
    for (const base of bases) {
      void (async () => {
        const ok = await probe(base);
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(base);
          return;
        }
        pending -= 1;
        if (pending === 0) resolve(null);
      })();
    }
  });
}

export function normalizePermissionPreset(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
  return PERMISSION_ALIASES[lowered] ?? trimmed;
}

export function toSessionRow(item: RawSessionListItem): DshSessionRow {
  const values = item.projections?.values ?? {};
  const stats = values.sessionStats;
  const ctx = values.contextTimeline;

  let status: DshSessionRow["status"] = "idle";
  if (item.running) status = "running";
  else if (values.pendingInteraction) status = "pending";

  const fallbackTitle = item.cwd ? basename(item.cwd) || item.sessionId : item.sessionId;
  const title = values.title ?? fallbackTitle;

  return {
    sessionId: item.sessionId,
    title,
    status,
    blank: Boolean(item.blank),
    cwd: item.cwd ?? null,
    agentPreset: item.agentPreset ?? null,
    model: ctx?.model ?? null,
    provider: ctx?.provider ?? null,
    updatedAt: item.updatedAt ?? null,
    turns: stats?.turns ?? null,
  };
}

export class DshProxyService {
  async resolveBaseUrl(explicit?: string): Promise<string> {
    const candidates: string[] = [];
    if (explicit) candidates.push(normalizeBase(explicit));
    for (const key of ["DSH_WEB_URL", "DSH_WS_URL"] as const) {
      const v = process.env[key]?.trim();
      if (v) candidates.push(normalizeBase(v));
    }
    candidates.push(...listPaseoDesktopHarnessBases());
    candidates.push(DEFAULT_BASE);

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const base of candidates) {
      if (!base || seen.has(base)) continue;
      seen.add(base);
      unique.push(base);
    }

    for (const base of unique) {
      if (await probe(base)) return base;
    }

    const loopback = listLoopbackHttpBases().filter((base) => !seen.has(base));
    const found = await probeFirstLive(loopback);
    if (found) return found;

    throw new Error(
      "No live DSH Web API found. Start DeepSeek Harness from Paseo Desktop, or set DSH_WEB_URL / pass baseUrl (e.g. http://127.0.0.1:64167).",
    );
  }

  async status(explicitBaseUrl?: string): Promise<DshStatus> {
    try {
      const baseUrl = await this.resolveBaseUrl(explicitBaseUrl);
      const portMatch = baseUrl.match(/:(\d+)$/);
      return {
        running: true,
        baseUrl,
        port: portMatch ? Number(portMatch[1]) : null,
      };
    } catch {
      return { running: false, baseUrl: null, port: null };
    }
  }

  async listSessions(options: {
    baseUrl?: string;
    includeAll?: boolean;
  }): Promise<{ baseUrl: string; sessions: DshSessionRow[] }> {
    const baseUrl = await this.resolveBaseUrl(options.baseUrl);
    const list = unwrap<{ items?: RawSessionListItem[] }>(
      await dshRpc(baseUrl, "session.list", {}),
      "session.list",
    );
    let sessions = (list.items ?? []).map(toSessionRow);
    if (!options.includeAll) {
      const raw = list.items ?? [];
      sessions = sessions.filter((_, i) => {
        const item = raw[i];
        return !item?.blank && item?.origin !== "subagent";
      });
    }
    return { baseUrl, sessions };
  }

  async resolveSessionId(baseUrl: string, sessionId: string): Promise<string> {
    const list = unwrap<{ items?: RawSessionListItem[] }>(
      await dshRpc(baseUrl, "session.list", {}),
      "session.list",
    );
    const items = list.items ?? [];
    const exact = items.find((it) => it.sessionId === sessionId);
    if (exact) return exact.sessionId;
    const short = String(sessionId)
      .replace(/^session-/, "")
      .match(SHORT_ID_RE)?.[0];
    if (short) {
      const matches = items.filter((it) =>
        it.sessionId
          .replace(/^session-/, "")
          .toLowerCase()
          .startsWith(short.toLowerCase()),
      );
      if (matches.length === 1) return matches[0]!.sessionId;
      if (matches.length > 1) {
        throw new Error(
          `session id ${JSON.stringify(sessionId)} is ambiguous: ${matches.length} matches`,
        );
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }

  async createSession(options: {
    baseUrl?: string;
    workspaceId?: string;
    cwd?: string;
    agentPreset?: string;
    permission?: string;
    prompt?: string;
  }): Promise<{
    baseUrl: string;
    sessionId: string;
    agentPreset: string | null;
    permission: string | null;
    accepted: boolean | null;
  }> {
    const baseUrl = await this.resolveBaseUrl(options.baseUrl);
    const payload: Record<string, unknown> = {};
    if (options.workspaceId) payload.workspaceId = options.workspaceId;
    else if (options.cwd) payload.cwd = options.cwd;
    if (options.agentPreset) payload.agentPreset = options.agentPreset;

    const created = unwrap<{ sessionId: string }>(
      await dshRpc(baseUrl, "session.create", payload),
      "session.create",
    );
    const sessionId = created.sessionId;

    let permission: string | null = null;
    if (options.permission) {
      const set = await this.setPermission({
        baseUrl,
        sessionId,
        permission: options.permission,
      });
      permission = set.permission;
    }

    let accepted: boolean | null = null;
    if (options.prompt) {
      const prompted = await this.prompt({
        baseUrl,
        sessionId,
        text: options.prompt,
        mode: "queue",
      });
      accepted = prompted.accepted;
    }

    return {
      baseUrl,
      sessionId,
      agentPreset: options.agentPreset ?? null,
      permission,
      accepted,
    };
  }

  async prompt(options: {
    baseUrl?: string;
    sessionId: string;
    text: string;
    mode?: "queue" | "steer";
  }): Promise<{ baseUrl: string; sessionId: string; accepted: boolean }> {
    const baseUrl = await this.resolveBaseUrl(options.baseUrl);
    const sessionId = await this.resolveSessionId(baseUrl, options.sessionId);
    const value = unwrap<{ accepted?: boolean }>(
      await dshRpc(baseUrl, "session.prompt", {
        sessionId,
        mode: options.mode ?? "queue",
        content: [{ type: "text", text: options.text }],
      }),
      "session.prompt",
    );
    return { baseUrl, sessionId, accepted: Boolean(value?.accepted) };
  }

  async setPermission(options: {
    baseUrl?: string;
    sessionId: string;
    permission: string;
  }): Promise<{ baseUrl: string; sessionId: string; permission: string; text: string | null }> {
    const baseUrl = await this.resolveBaseUrl(options.baseUrl);
    const sessionId = await this.resolveSessionId(baseUrl, options.sessionId);
    const preset = normalizePermissionPreset(options.permission);
    if (!preset) {
      throw new Error("permission preset is required");
    }
    const executed = unwrap<{ result?: { kind?: string; text?: string } }>(
      await dshRpc(baseUrl, "commands/execute", {
        args: {
          agentId: sessionId,
          line: `/permission ${preset}`,
          images: [],
        },
      }),
      "commands/execute",
    );
    const result = executed?.result;
    if (result?.kind === "error") {
      throw new Error(result.text || `permission preset failed: ${preset}`);
    }
    return {
      baseUrl,
      sessionId,
      permission: preset,
      text: result?.text ?? `preset ${preset}`,
    };
  }
}
