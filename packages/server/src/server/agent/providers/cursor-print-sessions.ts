import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentTimelineItem, ImportableProviderSession } from "../agent-sdk-types.js";
import { execCommand } from "../../../utils/spawn.js";

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
/** Known root-blob hash fields: message refs use 0x0a; siblings share the 0x20 + 32-byte shape. */
const ROOT_HASH_FIELD_TAGS = new Set([0x0a, 0x12, 0x1a, 0x22, 0x2a]);
const CONVERSATION_SUMMARY_RE = /^your conversation was summarized due to context constraints/i;

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

async function sqliteQuery(
  dbPath: string,
  sql: string,
  options?: { maxBuffer?: number },
): Promise<string> {
  try {
    const result = await execCommand("sqlite3", [dbPath, sql], {
      timeout: 5_000,
      maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function extractRootMessageIds(rootBytes: Buffer): string[] {
  const childIds: string[] = [];
  let i = 0;
  while (i < rootBytes.length) {
    if (
      i + 33 < rootBytes.length &&
      rootBytes[i + 1] === 0x20 &&
      ROOT_HASH_FIELD_TAGS.has(rootBytes[i] ?? -1)
    ) {
      if (rootBytes[i] === 0x0a) {
        childIds.push(rootBytes.subarray(i + 2, i + 34).toString("hex"));
      }
      i += 34;
      continue;
    }
    i += 1;
  }
  return childIds;
}

function contentTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type?: unknown }).type === "text" &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("");
}

function contentReasoningParts(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type?: unknown }).type === "reasoning" &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const text = (item as { text: string }).text.trim();
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

export function isSkippableHydratedUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (CONVERSATION_SUMMARY_RE.test(trimmed)) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  // Only drop known Cursor/system envelopes. Do not treat arbitrary `<...>`
  // (e.g. `<paseo_guidance>` inside a real `<user_query>`) as skippable.
  return (
    lower.startsWith("<user_info>") ||
    lower.startsWith("<open_and_recently_viewed_files>") ||
    lower.startsWith("<attached_files>") ||
    lower.startsWith("<agent_transcripts>") ||
    lower.startsWith("<hooks_context>") ||
    lower.startsWith("<agent_skills>") ||
    lower.startsWith("<mcp_file_system") ||
    lower.startsWith("<claude_code_")
  );
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
  // Read the full root blob — Cursor roots commonly exceed 8 KiB after long sessions.
  const rootHex = await sqliteQuery(
    dbPath,
    `SELECT hex(data) FROM blobs WHERE id='${rootBlobId.replace(/'/g, "''")}' LIMIT 1;`,
    { maxBuffer: 32 * 1024 * 1024 },
  );
  if (!rootHex) {
    return [];
  }
  const rootBytes = Buffer.from(rootHex, "hex");
  const childIds = extractRootMessageIds(rootBytes);
  if (childIds.length === 0) {
    return [];
  }

  const slice = childIds.slice(0, limit);
  const idsSql = slice.map((id) => `'${id}'`).join(",");
  const out = await sqliteQuery(dbPath, `SELECT id, data FROM blobs WHERE id IN (${idsSql});`, {
    maxBuffer: 64 * 1024 * 1024,
  });
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

function readRecordString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function collectToolResultsByCallId(
  messages: Array<{ role: string; content: unknown }>,
): Map<string, unknown> {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (record.type !== "tool-result") {
        continue;
      }
      const callId = readRecordString(record, ["toolCallId", "tool_call_id"]);
      if (!callId) {
        continue;
      }
      results.set(callId, record.result ?? record.output ?? null);
    }
  }
  return results;
}

/**
 * Project Cursor store.db conversation blobs into Paseo timeline items for resume hydration.
 * Skips system-injected user envelopes; maps tool-call / tool-result pairs into completed tool_call rows.
 */
export function projectCursorPrintMessagesToTimeline(
  messages: Array<{ role: string; content: unknown }>,
): AgentTimelineItem[] {
  const toolResults = collectToolResultsByCallId(messages);
  const items: AgentTimelineItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const summary = extractCursorUserSummary(message.content);
      if (!summary || isSkippableHydratedUserText(summary)) {
        continue;
      }
      items.push({ type: "user_message", text: summary });
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    const reasoning = contentReasoningParts(message.content);
    if (reasoning) {
      items.push({ type: "reasoning", text: reasoning });
    }

    const text = contentTextParts(message.content).trim();
    if (text) {
      items.push({ type: "assistant_message", text });
    }

    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (record.type !== "tool-call" && record.type !== "tool_call") {
        continue;
      }
      const callId =
        readRecordString(record, ["toolCallId", "tool_call_id"]) ??
        `cursor-history-${items.length}`;
      const name = readRecordString(record, ["toolName", "name"]) ?? "Tool";
      const input = record.args ?? record.input ?? record.arguments ?? null;
      const output = toolResults.has(callId) ? toolResults.get(callId) : null;
      items.push({
        type: "tool_call",
        callId,
        name,
        status: "completed",
        error: null,
        detail: { type: "unknown", input, output },
      });
    }
  }

  return items;
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
  const items = await readCursorPrintTimelineHistory(options);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const item of items) {
    if (item.type === "user_message") {
      history.push({ role: "user", text: item.text });
    } else if (item.type === "assistant_message") {
      history.push({ role: "assistant", text: item.text });
    }
  }
  return history;
}

export async function readCursorPrintTimelineHistory(options: {
  cwd: string;
  sessionId: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentTimelineItem[]> {
  const dir = await findCursorPrintSessionDir(options.cwd, options.sessionId, {
    homeDir: options.homeDir,
    env: options.env,
  });
  if (!dir) {
    return [];
  }
  const dbPath = join(dir, "store.db");
  const meta = await readSessionMeta(dbPath);
  const messages = await readConversationBlobs(dbPath, meta.rootBlobId, 500);
  return projectCursorPrintMessagesToTimeline(messages);
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
