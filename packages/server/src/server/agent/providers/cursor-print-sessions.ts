import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ImportableProviderSession } from "../agent-sdk-types.js";
import { execCommand } from "../../../utils/spawn.js";

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

export interface CursorPrintSessionInfo {
  id: string;
  summary: string;
  messageCount: number;
  modifiedAt: Date;
  dir: string;
}

export function resolveAbsoluteWorkspace(cwd: string): string {
  return resolve(cwd);
}

/** MD5 of the absolute workspace path — Cursor's chat bucket key. */
export function cursorWorkspaceHash(workDir: string): string {
  return createHash("md5").update(resolveAbsoluteWorkspace(workDir)).digest("hex");
}

export function cursorChatsBaseDirs(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    dirs.push(path);
  };

  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    add(join(xdg, "Cursor", "chats"));
  }
  add(join(homeDir, ".config", "Cursor", "chats"));
  add(join(homeDir, ".cursor", "chats"));
  return dirs;
}

export async function listCursorWorkspaceChatDirs(
  workDir: string,
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const hash = cursorWorkspaceHash(workDir);
  const found: string[] = [];
  for (const base of cursorChatsBaseDirs(homeDir, env)) {
    const dir = join(base, hash);
    try {
      const info = await stat(dir);
      if (info.isDirectory()) {
        found.push(dir);
      }
    } catch {
      // missing bucket
    }
  }
  return found;
}

async function sqliteQuery(dbPath: string, sql: string): Promise<string> {
  try {
    const result = await execCommand("sqlite3", [dbPath, sql], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function decodeHexOrRaw(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    try {
      return Buffer.from(trimmed, "hex").toString("utf8");
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

interface SessionMeta {
  name: string;
  rootBlobId: string;
}

async function readSessionMeta(dbPath: string): Promise<SessionMeta> {
  const raw = await sqliteQuery(dbPath, "SELECT value FROM meta WHERE key='0' LIMIT 1;");
  if (!raw) {
    return { name: "", rootBlobId: "" };
  }
  try {
    const parsed = JSON.parse(decodeHexOrRaw(raw)) as {
      name?: string;
      latestRootBlobId?: string;
    };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      rootBlobId: typeof parsed.latestRootBlobId === "string" ? parsed.latestRootBlobId : "",
    };
  } catch {
    return { name: "", rootBlobId: "" };
  }
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join(" ");
}

export function extractCursorUserSummary(content: unknown): string {
  const text = messageContentText(content).trim();
  if (!text) {
    return "";
  }
  const match = USER_QUERY_RE.exec(text);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  const lower = text.toLowerCase();
  if (
    lower.startsWith("<user_info>") ||
    lower.startsWith("<open_and_recently_viewed_files>") ||
    lower.startsWith("<attached_files>") ||
    lower.startsWith("<agent_transcripts>") ||
    text.startsWith("<")
  ) {
    return "";
  }
  return text;
}

function truncateSummary(summary: string, maxRunes = 60): string {
  const chars = [...summary];
  if (chars.length <= maxRunes) {
    return summary;
  }
  return `${chars.slice(0, maxRunes).join("")}...`;
}

function sessionSummary(metaName: string, firstUserMsg: string, sessionId: string): string {
  let summary = metaName.trim();
  if (!summary || summary.toLowerCase() === "new agent") {
    summary = firstUserMsg.trim();
  }
  if (!summary) {
    summary = sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId;
  }
  return truncateSummary(summary);
}

async function readConversationBlobs(
  dbPath: string,
  rootBlobId: string,
  limit = 80,
): Promise<Array<{ role: string; content: unknown }>> {
  if (!rootBlobId) {
    return [];
  }
  const rootHex = await sqliteQuery(
    dbPath,
    `SELECT hex(substr(data,1,8192)) FROM blobs WHERE id='${rootBlobId.replace(/'/g, "''")}' LIMIT 1;`,
  );
  if (!rootHex) {
    return [];
  }
  const rootBytes = Buffer.from(rootHex, "hex");
  const childIds: string[] = [];
  let i = 0;
  while (i + 33 < rootBytes.length && rootBytes[i] === 0x0a && rootBytes[i + 1] === 0x20) {
    childIds.push(rootBytes.subarray(i + 2, i + 34).toString("hex"));
    i += 34;
  }
  if (childIds.length === 0) {
    return [];
  }

  const slice = childIds.slice(0, limit);
  const idsSql = slice.map((id) => `'${id}'`).join(",");
  const out = await sqliteQuery(dbPath, `SELECT id, data FROM blobs WHERE id IN (${idsSql});`);
  if (!out) {
    return [];
  }

  const byId = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const sep = line.indexOf("|");
    if (sep < 0) {
      continue;
    }
    byId.set(line.slice(0, sep), line.slice(sep + 1));
  }

  const messages: Array<{ role: string; content: unknown }> = [];
  for (const id of slice) {
    const raw = byId.get(id);
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { role?: string; content?: unknown };
      if (typeof parsed.role === "string") {
        messages.push({ role: parsed.role, content: parsed.content });
      }
    } catch {
      // binary / non-JSON blob
    }
  }
  return messages;
}

export async function listCursorPrintSessions(
  workDir: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CursorPrintSessionInfo[]> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const chatsDirs = await listCursorWorkspaceChatDirs(workDir, homeDir, env);
  const byId = new Map<string, CursorPrintSessionInfo>();

  for (const chatsDir of chatsDirs) {
    let entries: string[];
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }
    for (const sessionId of entries) {
      const dir = join(chatsDir, sessionId);
      const dbPath = join(dir, "store.db");
      let modifiedAt: Date;
      try {
        const info = await stat(dbPath);
        if (!info.isFile()) {
          continue;
        }
        modifiedAt = info.mtime;
      } catch {
        continue;
      }

      const meta = await readSessionMeta(dbPath);
      const messages = await readConversationBlobs(dbPath, meta.rootBlobId);
      let firstUserMsg = "";
      let messageCount = 0;
      for (const message of messages) {
        if (message.role === "user" || message.role === "assistant") {
          messageCount += 1;
        }
        if (message.role === "user" && !firstUserMsg) {
          firstUserMsg = extractCursorUserSummary(message.content);
        }
      }

      const candidate: CursorPrintSessionInfo = {
        id: sessionId,
        summary: sessionSummary(meta.name, firstUserMsg, sessionId),
        messageCount,
        modifiedAt,
        dir,
      };
      const existing = byId.get(sessionId);
      if (!existing || candidate.modifiedAt > existing.modifiedAt) {
        byId.set(sessionId, candidate);
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export async function findCursorPrintSessionDir(
  workDir: string,
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  for (const chatsDir of await listCursorWorkspaceChatDirs(workDir, homeDir, env)) {
    const dir = join(chatsDir, sessionId);
    try {
      const info = await stat(dir);
      if (info.isDirectory()) {
        return dir;
      }
    } catch {
      // continue
    }
  }
  return null;
}

export async function deleteCursorPrintSession(
  workDir: string,
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const dir = await findCursorPrintSessionDir(workDir, sessionId, options);
  if (!dir) {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

export async function listCursorPrintImportableSessions(options: {
  cwd?: string;
  limit?: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ImportableProviderSession[]> {
  if (!options.cwd) {
    return [];
  }
  const cwd = resolveAbsoluteWorkspace(options.cwd);
  const limit = options.limit ?? 20;
  const sessions = await listCursorPrintSessions(cwd, {
    homeDir: options.homeDir,
    env: options.env,
  });
  return sessions.slice(0, limit).map((session) => ({
    providerHandleId: session.id,
    cwd,
    title: session.summary || null,
    firstPromptPreview: session.summary || null,
    lastPromptPreview: null,
    lastActivityAt: session.modifiedAt,
  }));
}

export async function readCursorPrintHistory(options: {
  cwd: string;
  sessionId: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const dir = await findCursorPrintSessionDir(options.cwd, options.sessionId, {
    homeDir: options.homeDir,
    env: options.env,
  });
  if (!dir) {
    return [];
  }
  const dbPath = join(dir, "store.db");
  const meta = await readSessionMeta(dbPath);
  const messages = await readConversationBlobs(dbPath, meta.rootBlobId, 200);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text =
      message.role === "user"
        ? extractCursorUserSummary(message.content) || messageContentText(message.content).trim()
        : messageContentText(message.content).trim();
    if (!text) {
      continue;
    }
    history.push({ role: message.role, text });
  }
  return history;
}

export function isCursorResumeFailure(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("session not found") ||
    lower.includes("chat not found") ||
    lower.includes("unable to resume") ||
    lower.includes("failed to resume") ||
    lower.includes("no conversation found") ||
    lower.includes("unknown session")
  );
}
