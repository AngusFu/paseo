import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { extractCursorUserSummary, isSkippableHydratedUserText } from "./cursor-print-sessions.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorProjectsRoot(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return join(xdg, "Cursor", "projects");
  }
  return join(homeDir, ".cursor", "projects");
}

/**
 * Locate Cursor agent-transcripts JSONL for a print/chat session id.
 * Layout: `~/.cursor/projects/<project>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
 */
export async function findCursorPrintAgentTranscript(
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const projectsRoot = cursorProjectsRoot(homeDir, env);
  let projectEntries: string[];
  try {
    projectEntries = await readdir(projectsRoot);
  } catch {
    return null;
  }

  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const project of projectEntries) {
    const candidate = join(
      projectsRoot,
      project,
      "agent-transcripts",
      sessionId,
      `${sessionId}.jsonl`,
    );
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        continue;
      }
      if (info.mtimeMs >= bestMtime) {
        bestMtime = info.mtimeMs;
        bestPath = candidate;
      }
    } catch {
      // missing
    }
  }
  return bestPath;
}

function contentFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return message;
  }
  return message.content;
}

function textPartsFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
    ) {
      parts.push(item.text);
    }
  }
  return parts.join("");
}

function parseTranscriptLine(line: string): { role: string; content: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.role !== "string") {
    return null;
  }
  return { role: parsed.role, content: contentFromMessage(parsed.message ?? parsed) };
}

function appendAssistantToolCalls(
  content: unknown,
  items: AgentTimelineItem[],
  startToolIndex: number,
): number {
  if (!Array.isArray(content)) {
    return startToolIndex;
  }
  let toolIndex = startToolIndex;
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.type !== "tool_use" && part.type !== "tool-use") {
      continue;
    }
    const name = typeof part.name === "string" && part.name.trim() ? part.name : "Tool";
    let callId = `transcript-tool-${toolIndex}`;
    if (typeof part.id === "string" && part.id.trim()) {
      callId = part.id;
    } else if (typeof part.toolCallId === "string" && part.toolCallId.trim()) {
      callId = part.toolCallId;
    }
    toolIndex += 1;
    items.push({
      type: "tool_call",
      callId,
      name,
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: part.input ?? part.arguments ?? null,
        output: null,
      },
    });
  }
  return toolIndex;
}

/**
 * Project Cursor agent-transcripts JSONL lines into Paseo timeline items.
 * Transcripts are typically richer than summarized store.db roots, but usually
 * omit tool results — tool_use becomes completed tool_call with output null.
 */
export function projectCursorPrintTranscriptToTimeline(
  lines: readonly string[],
): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  let toolIndex = 0;

  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry) {
      continue;
    }

    if (entry.role === "user") {
      const summary = extractCursorUserSummary(entry.content);
      if (!summary || isSkippableHydratedUserText(summary)) {
        continue;
      }
      items.push({ type: "user_message", text: summary });
      continue;
    }

    if (entry.role !== "assistant") {
      continue;
    }

    const text = textPartsFromContent(entry.content).trim();
    if (text) {
      items.push({ type: "assistant_message", text });
    }
    toolIndex = appendAssistantToolCalls(entry.content, items, toolIndex);
  }

  return items;
}

export async function readCursorPrintTranscriptTimeline(options: {
  sessionId: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentTimelineItem[]> {
  const path = await findCursorPrintAgentTranscript(options.sessionId, {
    homeDir: options.homeDir,
    env: options.env,
  });
  if (!path) {
    return [];
  }
  const raw = await readFile(path, "utf8");
  return projectCursorPrintTranscriptToTimeline(raw.split("\n"));
}
