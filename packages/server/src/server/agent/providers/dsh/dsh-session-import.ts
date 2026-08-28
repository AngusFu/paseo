import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type {
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../../agent-sdk-types.js";
import { createRealpathAwarePathMatcher } from "../../../../utils/path.js";
import { DSH_SESSION_PREFIX, type DshLocationOptions, resolveDshSessionRoot } from "./dsh-home.js";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

export interface DshSessionImportOptions
  extends ListImportableSessionsOptions, DshLocationOptions {}

export interface DshImportSessionConfig {
  model?: string;
}

interface DshSessionHeader {
  sessionId: string;
  cwd: string;
  createdAt: Date | null;
}

interface DshSessionDescriptor {
  sessionId: string;
  cwd: string;
  title: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastActivityAt: Date;
  model: string | null;
}

export async function listDshImportableSessions(
  options: DshSessionImportOptions = {},
): Promise<ImportableProviderSession[]> {
  const sessionRoot = resolveDshSessionRoot(options);
  const matchesCwd = options.cwd ? createRealpathAwarePathMatcher(options.cwd) : null;
  const limit = options.limit ?? 20;
  const candidates = await collectSessionDirs(sessionRoot);
  const sessions: ImportableProviderSession[] = [];

  for (const sessionDir of candidates) {
    const descriptor = await readDshSessionDescriptor(sessionDir);
    if (!descriptor) {
      continue;
    }
    if (matchesCwd && !matchesCwd(descriptor.cwd)) {
      continue;
    }
    sessions.push({
      providerHandleId: descriptor.sessionId,
      cwd: descriptor.cwd,
      title: descriptor.title,
      firstPromptPreview: normalizePromptPreview(descriptor.firstUserMessage),
      lastPromptPreview: normalizePromptPreview(
        descriptor.lastUserMessage ?? descriptor.firstUserMessage,
      ),
      lastActivityAt: descriptor.lastActivityAt,
    });
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions.sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

export async function readDshImportSessionConfig(
  sessionId: string,
  options: DshSessionImportOptions = {},
): Promise<DshImportSessionConfig> {
  const descriptor = await findDshSessionDescriptor(sessionId, options);
  if (!descriptor?.model) {
    return {};
  }
  return { model: descriptor.model };
}

async function collectSessionDirs(sessionRoot: string): Promise<string[]> {
  const buckets = await readChildDirs(sessionRoot);
  const sessionDirs: Array<{ dir: string; mtime: Date }> = [];

  for (const bucket of buckets) {
    const entries = await readChildDirs(bucket);
    for (const entry of entries) {
      const name = entry.split("/").pop() ?? entry;
      if (!name.startsWith(DSH_SESSION_PREFIX)) {
        continue;
      }
      const mtime = await readDirMtime(entry);
      if (mtime) {
        sessionDirs.push({ dir: entry, mtime });
      }
    }
  }

  sessionDirs.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
  return sessionDirs.map((entry) => entry.dir);
}

async function findDshSessionDescriptor(
  sessionId: string,
  options: DshSessionImportOptions,
): Promise<DshSessionDescriptor | null> {
  const normalized = sessionId.startsWith(DSH_SESSION_PREFIX)
    ? sessionId
    : `${DSH_SESSION_PREFIX}${sessionId}`;
  const sessionRoot = resolveDshSessionRoot(options);
  const buckets = await readChildDirs(sessionRoot);
  for (const bucket of buckets) {
    const candidate = join(bucket, normalized);
    const descriptor = await readDshSessionDescriptor(candidate);
    if (descriptor) {
      return descriptor;
    }
  }
  return null;
}

async function readDshSessionDescriptor(sessionDir: string): Promise<DshSessionDescriptor | null> {
  const logPath = await resolveSessionLogPath(sessionDir);
  if (!logPath) {
    return null;
  }

  const bytes = await readSessionLogBytes(logPath);
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const header = parseSessionHeader(lines[0]);
  if (!header) {
    return null;
  }

  const tailText = text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
  const tailInfo = parseSessionTail(tailText);
  const headInfo = parseSessionHead(text.slice(0, HEAD_BYTES));
  const mtime = (await readDirMtime(sessionDir)) ?? header.createdAt ?? new Date(0);

  return {
    sessionId: header.sessionId,
    cwd: header.cwd,
    title: tailInfo.title ?? headInfo.title,
    firstUserMessage: headInfo.firstUserMessage,
    lastUserMessage: tailInfo.lastUserMessage,
    lastActivityAt: tailInfo.lastActivityAt ?? mtime,
    model: tailInfo.model ?? headInfo.model,
  };
}

async function resolveSessionLogPath(sessionDir: string): Promise<string | null> {
  const zstdPath = join(sessionDir, "session.jsonl.zstd");
  const jsonlPath = join(sessionDir, "session.jsonl");
  try {
    await stat(zstdPath);
    return zstdPath;
  } catch {
    // fall through
  }
  try {
    await stat(jsonlPath);
    return jsonlPath;
  } catch {
    return null;
  }
}

async function readSessionLogBytes(path: string): Promise<Buffer> {
  const data = await readFile(path);
  if (path.endsWith(".zstd")) {
    return zstdDecompressSync(data);
  }
  return data;
}

async function readChildDirs(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function readDirMtime(dir: string): Promise<Date | null> {
  try {
    return (await stat(dir)).mtime;
  } catch {
    return null;
  }
}

function parseSessionHeader(firstLine: string): DshSessionHeader | null {
  const entry = parseJsonRecord(firstLine);
  if (!entry || entry.type !== "session") {
    return null;
  }
  const sessionId = typeof entry.id === "string" ? entry.id : null;
  const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
  if (!sessionId || !cwd) {
    return null;
  }
  return {
    sessionId,
    cwd,
    createdAt: parseDate(entry.createdAt),
  };
}

function parseSessionHead(chunk: string): {
  title: string | null;
  firstUserMessage: string | null;
  model: string | null;
} {
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let model: string | null = null;

  for (const rawLine of chunk.split(/\r?\n/u)) {
    const entry = parseJsonRecord(rawLine.trim());
    if (!entry) {
      continue;
    }
    if (entry.type === "session_info" && isRecord(entry.data)) {
      title = readNonEmptyString(entry.data.name) ?? title;
    }
    model = extractModel(entry) ?? model;
    const userText = extractUserMessage(entry);
    if (!firstUserMessage && userText) {
      firstUserMessage = userText;
    }
    if (title && firstUserMessage && model) {
      break;
    }
  }

  return { title, firstUserMessage, model };
}

function parseSessionTail(tail: string): {
  title: string | null;
  lastUserMessage: string | null;
  lastActivityAt: Date | null;
  model: string | null;
} {
  const lines = tail.split(/\r?\n/u);
  let title: string | null = null;
  let lastUserMessage: string | null = null;
  let lastActivityAt: Date | null = null;
  let model: string | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJsonRecord(lines[index]?.trim() ?? "");
    if (!entry) {
      continue;
    }
    const entryTime = parseDate(entry.time);
    if (!lastActivityAt && entryTime) {
      lastActivityAt = entryTime;
    }
    if (entry.type === "session_info" && isRecord(entry.data)) {
      title = readNonEmptyString(entry.data.name) ?? title;
    }
    model = extractModel(entry) ?? model;
    const userText = extractUserMessage(entry);
    if (!lastUserMessage && userText) {
      lastUserMessage = userText;
    }
  }

  return { title, lastUserMessage, lastActivityAt, model };
}

function extractUserMessage(entry: Record<string, unknown>): string | null {
  if (entry.type === "user/message" && isRecord(entry.data)) {
    return extractMessageText(entry.data.content);
  }
  if (
    entry.type === "agent/inbox/spliced" &&
    isRecord(entry.data) &&
    Array.isArray(entry.data.inserted)
  ) {
    for (const item of entry.data.inserted) {
      if (!isRecord(item) || item.role !== "user") {
        continue;
      }
      const text = extractMessageText(item.content);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function extractModel(entry: Record<string, unknown>): string | null {
  if (entry.type === "model/change" && isRecord(entry.data)) {
    return buildModelId(entry.data.provider, entry.data.model);
  }
  if (entry.type === "assistant/message" && isRecord(entry.data)) {
    return buildModelId(entry.data.provider, entry.data.model);
  }
  return null;
}

function buildModelId(provider: unknown, model: unknown): string | null {
  const providerName = readNonEmptyString(provider);
  const modelName = readNonEmptyString(model);
  if (!providerName || !modelName) {
    return null;
  }
  if (providerName.includes("/")) {
    return `${providerName}/${modelName}`;
  }
  return modelName;
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n")
    .trim();
  return text || null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePromptPreview(text: string | null): string | null {
  const normalized = text?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) {
    return null;
  }
  return normalized.length > 160 ? normalized.slice(0, 160) : normalized;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
