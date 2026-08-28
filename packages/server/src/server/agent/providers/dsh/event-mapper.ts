import type { AgentStreamEvent, ToolCallDetail } from "../../agent-sdk-types.js";
import type { JsonRpcNotification } from "./jsonrpc-transport.js";

export interface DshSessionEvent {
  type: string;
  data?: unknown;
  seq?: number;
}

export interface MapDshNotificationContext {
  provider: string;
  sessionId: string;
  turnId: string | undefined;
  activeAssistantMessageId: string | null;
  /** callId → launch metadata so tool/result can keep name + shell detail */
  toolCalls: Map<string, { name: string; args: unknown }>;
}

export interface MapDshNotificationResult {
  events: AgentStreamEvent[];
  activeAssistantMessageId: string | null;
  inboxReceipt: boolean;
  turnIdle: boolean;
}

export function isInboxReceipt(
  notification: JsonRpcNotification,
  sessionId: string,
  messageId: string,
): boolean {
  if (notification.method !== "session.event") {
    return false;
  }
  const params = asRecord(notification.params);
  if (!params || params.sessionId !== sessionId) {
    return false;
  }
  const event = asRecord(params.event);
  if (!event || event.type !== "agent/inbox/spliced") {
    return false;
  }
  const data = asRecord(event.data);
  const inserted = data?.inserted;
  if (!Array.isArray(inserted)) {
    return false;
  }
  return inserted.some((message) => {
    const record = asRecord(message);
    return record?.id === messageId;
  });
}

export function mapDshNotification(
  notification: JsonRpcNotification,
  context: MapDshNotificationContext,
): MapDshNotificationResult {
  const events: AgentStreamEvent[] = [];
  let activeAssistantMessageId = context.activeAssistantMessageId;
  let inboxReceipt = false;
  let turnIdle = false;

  if (notification.method === "session.status") {
    const params = asRecord(notification.params);
    if (params?.sessionId === context.sessionId && params.status === "idle") {
      turnIdle = true;
    }
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (notification.method !== "session.event") {
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  const params = asRecord(notification.params);
  if (!params || params.sessionId !== context.sessionId) {
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  const event = asRecord(params.event);
  if (!event || typeof event.type !== "string") {
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (event.type === "agent/inbox/spliced") {
    inboxReceipt = true;
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (event.type === "user/message") {
    const text = extractUserMessageText(event.data);
    const messageId = extractUserMessageId(event.data);
    if (text) {
      events.push({
        type: "timeline",
        provider: context.provider,
        turnId: context.turnId,
        item: {
          type: "user_message",
          text,
          ...(messageId ? { messageId } : {}),
        },
      });
    }
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (event.type === "assistant/chunk") {
    const mapped = mapAssistantChunk(event.data, context, activeAssistantMessageId);
    activeAssistantMessageId = mapped.activeAssistantMessageId;
    events.push(...mapped.events);
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (event.type === "tool/call") {
    const toolEvent = mapToolCall(event.data, context);
    if (toolEvent) {
      events.push(toolEvent);
    }
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  if (event.type === "tool/result") {
    const toolEvent = mapToolResult(event.data, context);
    if (toolEvent) {
      events.push(toolEvent);
    }
    return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
  }

  return { events, activeAssistantMessageId, inboxReceipt, turnIdle };
}

function mapAssistantChunk(
  data: unknown,
  context: MapDshNotificationContext,
  activeAssistantMessageId: string | null,
): { events: AgentStreamEvent[]; activeAssistantMessageId: string | null } {
  const record = asRecord(data);
  const chunk = asRecord(record?.chunk);
  if (!chunk || typeof chunk.type !== "string") {
    return { events: [], activeAssistantMessageId };
  }

  if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
    const messageId = activeAssistantMessageId ?? `dsh-assistant-${context.turnId ?? "turn"}`;
    return {
      activeAssistantMessageId: messageId,
      events: [
        {
          type: "timeline",
          provider: context.provider,
          turnId: context.turnId,
          item: {
            type: "assistant_message",
            text: chunk.text,
            messageId,
          },
        },
      ],
    };
  }

  if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
    return {
      activeAssistantMessageId,
      events: [
        {
          type: "timeline",
          provider: context.provider,
          turnId: context.turnId,
          item: {
            type: "reasoning",
            text: chunk.text,
          },
        },
      ],
    };
  }

  return { events: [], activeAssistantMessageId };
}

function mapToolCall(data: unknown, context: MapDshNotificationContext): AgentStreamEvent | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const callId = typeof record.callId === "string" ? record.callId : null;
  const name = typeof record.name === "string" ? record.name : "tool";
  if (!callId) {
    return null;
  }
  const args = parseToolArguments(record.arguments);
  context.toolCalls.set(callId, { name, args });
  return {
    type: "timeline",
    provider: context.provider,
    turnId: context.turnId,
    item: {
      type: "tool_call",
      callId,
      name,
      status: "running",
      error: null,
      detail: mapToolDetail(name, args, null),
    },
  };
}

function mapToolResult(data: unknown, context: MapDshNotificationContext): AgentStreamEvent | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const message = asRecord(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const toolResult = asRecord(block);
    if (!toolResult || toolResult.type !== "tool-result") {
      continue;
    }
    const callId = resolveToolResultCallId(toolResult, message);
    if (!callId) {
      continue;
    }
    const outputText = extractToolResultText(toolResult.content);
    const isError = toolResult.isError === true;
    const prior = context.toolCalls.get(callId);
    const name = prior?.name ?? "tool";
    const detail = mapToolDetail(name, prior?.args ?? null, outputText);
    if (isError) {
      return {
        type: "timeline",
        provider: context.provider,
        turnId: context.turnId,
        item: {
          type: "tool_call",
          callId,
          name,
          status: "failed",
          error: outputText,
          detail,
        },
      };
    }
    return {
      type: "timeline",
      provider: context.provider,
      turnId: context.turnId,
      item: {
        type: "tool_call",
        callId,
        name,
        status: "completed",
        error: null,
        detail,
      },
    };
  }
  return null;
}

function mapToolDetail(name: string, args: unknown, output: string | null): ToolCallDetail {
  if (name === "bash") {
    const record = asRecord(args);
    const command = typeof record?.command === "string" ? record.command : "";
    return {
      type: "shell",
      command,
      ...(output !== null ? { output } : {}),
    };
  }
  return {
    type: "unknown",
    input: args,
    output,
  };
}

function resolveToolResultCallId(
  toolResult: Record<string, unknown>,
  message: Record<string, unknown> | null,
): string | null {
  if (typeof toolResult.toolCallId === "string") {
    return toolResult.toolCallId;
  }
  const source = asRecord(message?.source);
  if (typeof source?.callId === "string") {
    return source.callId;
  }
  return null;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractUserMessageText(data: unknown): string | null {
  const record = asRecord(data);
  const content = record?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const entry = asRecord(block);
    if (entry?.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function extractUserMessageId(data: unknown): string | undefined {
  const record = asRecord(data);
  return typeof record?.id === "string" ? record.id : undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    const entry = asRecord(block);
    if (entry?.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
