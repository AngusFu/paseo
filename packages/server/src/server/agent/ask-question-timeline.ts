import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";

import type { AgentTimelineItem, ToolCallDetail, ToolCallTimelineItem } from "./agent-sdk-types.js";

/** Claude Code's native question tool — old official apps render this by name. */
export const CLAUDE_ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

function compactToolToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readQuestionsInput(detail: ToolCallDetail): Record<string, unknown> | null {
  if (detail.type !== "unknown") {
    return null;
  }
  const input = detail.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return null;
  }
  return record;
}

function looksLikeAskQuestionTitle(value: string): boolean {
  const token = compactToolToken(value);
  return token.includes("asktheuseraquestion") || token === "askquestion";
}

/**
 * Cursor ACP often surfaces in-flight MCP tools as an opaque shell:
 * `name: "other"`, `metadata.title: "MCP: tool"`, empty `detail.input`.
 * When `askAgentQuestion` is running, that shell is the ask_question call.
 */
export function isOpaqueAcpMcpToolCall(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): boolean {
  const title = typeof item.metadata?.title === "string" ? item.metadata.title : "";
  const titleToken = compactToolToken(title);
  if (titleToken === "mcptool" || titleToken.startsWith("mcptool")) {
    return true;
  }
  return (
    compactToolToken(item.name) === "other" &&
    (item.metadata?.kind === "other" || titleToken.includes("mcp"))
  );
}

/**
 * COMPAT(askQuestionAskUserQuestionDisguise): identify Paseo's MCP ask_question
 * tool calls across providers (Claude `mcp__paseo__ask_question`, ACP human
 * titles, bare `ask_question`) so they can be projected like Claude's native
 * AskUserQuestion on the timeline.
 */
export function isPaseoAskQuestionToolCall(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): boolean {
  if (getPaseoToolLeafName(item.name) === "ask_question") {
    return true;
  }

  if (isOpaqueAcpMcpToolCall(item) && readQuestionsInput(item.detail)) {
    return true;
  }

  const nameToken = compactToolToken(item.name);
  if (nameToken === "askquestion") {
    return true;
  }
  if (looksLikeAskQuestionTitle(item.name) && readQuestionsInput(item.detail)) {
    return true;
  }

  const title = typeof item.metadata?.title === "string" ? item.metadata.title : "";
  if (looksLikeAskQuestionTitle(title) && readQuestionsInput(item.detail)) {
    return true;
  }

  return false;
}

export function buildAskUserQuestionToolCall(params: {
  callId: string;
  questions: unknown[];
  status?: ToolCallTimelineItem["status"];
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}): ToolCallTimelineItem {
  const status = params.status ?? "running";
  const detail: ToolCallDetail = {
    type: "unknown",
    input: { questions: params.questions },
    output: params.output ?? null,
  };
  const base = {
    type: "tool_call" as const,
    callId: params.callId,
    name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    detail,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: params.error ?? { message: "Question dismissed" },
    };
  }
  if (status === "canceled") {
    return { ...base, status: "canceled", error: null };
  }
  if (status === "completed") {
    return { ...base, status: "completed", error: null };
  }
  return { ...base, status: "running", error: null };
}

function withAskUserQuestionName(item: ToolCallTimelineItem): ToolCallTimelineItem {
  const questionsInput = readQuestionsInput(item.detail);
  if (!questionsInput) {
    return {
      ...item,
      name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    };
  }

  // Keep questions in detail.unknown.input — AskQuestionCard parses that shape.
  return {
    ...item,
    name: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    detail: {
      type: "unknown",
      input: questionsInput,
      output: item.detail.type === "unknown" ? item.detail.output : null,
    },
  };
}

/**
 * Project MCP ask_question timeline tool calls to Claude's AskUserQuestion wire
 * shape so older official apps that key off that tool name render AskQuestionCard.
 *
 * Mirrors speak-tool normalization (`mcp__paseo__speak` → `speak`) but applied
 * in the shared timeline funnel so every provider is covered.
 */
export function projectAskQuestionTimelineToolCall(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call") {
    return item;
  }
  if (item.name === CLAUDE_ASK_USER_QUESTION_TOOL_NAME) {
    return withAskUserQuestionName(item);
  }
  if (!isPaseoAskQuestionToolCall(item)) {
    return item;
  }
  return withAskUserQuestionName(item);
}
