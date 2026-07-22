import { z } from "zod";

// Local LLM chat RPCs (docs/rpc-namespacing.md). Multi-turn conversations with
// the daemon's built-in on-device model. The daemon owns the chat loop (history
// replay, optional tool calls) and persists each chat to
// $PASEO_HOME/llm-chat/<chatId>.json; clients render streamed events.

// ---------------------------------------------------------------------------
// Stored chat shapes
// ---------------------------------------------------------------------------

export const LlmChatToolCallSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  summary: z.string(),
});

export type LlmChatToolCall = z.infer<typeof LlmChatToolCallSchema>;

export const LlmChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string(),
  toolCalls: z.array(LlmChatToolCallSchema).optional(),
});

export type LlmChatMessage = z.infer<typeof LlmChatMessageSchema>;

export const StoredLlmChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(LlmChatMessageSchema),
});

export type StoredLlmChat = z.infer<typeof StoredLlmChatSchema>;

export const LlmChatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
});

export type LlmChatSummary = z.infer<typeof LlmChatSummarySchema>;

// ---------------------------------------------------------------------------
// Requests (client → daemon)
// ---------------------------------------------------------------------------

export const LlmChatListRequestSchema = z.object({
  type: z.literal("llm.chat.list.request"),
  requestId: z.string(),
});

export const LlmChatGetRequestSchema = z.object({
  type: z.literal("llm.chat.get.request"),
  requestId: z.string(),
  chatId: z.string(),
});

export const LlmChatSendRequestSchema = z.object({
  type: z.literal("llm.chat.send.request"),
  requestId: z.string(),
  // null starts a new chat; the response carries the assigned chatId.
  chatId: z.string().nullable(),
  text: z.string().min(1),
});

export const LlmChatCancelRequestSchema = z.object({
  type: z.literal("llm.chat.cancel.request"),
  requestId: z.string(),
  chatId: z.string(),
});

export const LlmChatDeleteRequestSchema = z.object({
  type: z.literal("llm.chat.delete.request"),
  requestId: z.string(),
  chatId: z.string(),
});

// ---------------------------------------------------------------------------
// Responses / events (daemon → client)
// ---------------------------------------------------------------------------

export const LlmChatListResponseSchema = z.object({
  type: z.literal("llm.chat.list.response"),
  payload: z.object({
    requestId: z.string(),
    chats: z.array(LlmChatSummarySchema),
  }),
});

export const LlmChatGetResponseSchema = z.object({
  type: z.literal("llm.chat.get.response"),
  payload: z.object({
    requestId: z.string(),
    chat: StoredLlmChatSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LlmChatSendResponseSchema = z.object({
  type: z.literal("llm.chat.send.response"),
  payload: z.object({
    requestId: z.string(),
    chatId: z.string(),
    // The completed assistant message, or null when generation failed.
    message: LlmChatMessageSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LlmChatEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chunk"), text: z.string() }),
  z.object({
    kind: z.literal("tool_call"),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("tool_result"),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  z.object({ kind: z.literal("done") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export type LlmChatEvent = z.infer<typeof LlmChatEventSchema>;

// Unsolicited push while a send is in flight, broadcast to all connected
// clients so every device tracks the stream; clients filter by sendRequestId.
export const LlmChatEventMessageSchema = z.object({
  type: z.literal("llm.chat.event"),
  payload: z.object({
    chatId: z.string(),
    sendRequestId: z.string(),
    event: LlmChatEventSchema,
  }),
});

export const LlmChatCancelResponseSchema = z.object({
  type: z.literal("llm.chat.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    cancelled: z.boolean(),
  }),
});

export const LlmChatDeleteResponseSchema = z.object({
  type: z.literal("llm.chat.delete.response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
    error: z.string().nullable(),
  }),
});
