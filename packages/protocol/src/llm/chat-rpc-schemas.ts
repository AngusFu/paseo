import { z } from "zod";

// Local LLM chat RPCs (docs/rpc-namespacing.md). Multi-turn conversations with
// the daemon's built-in on-device model. The daemon owns the chat loop (history
// replay, optional tool calls) and persists each chat to
// $PASEO_HOME/llm-chat/<chatId>.json; clients render streamed events.

// ---------------------------------------------------------------------------
// Stored chat shapes
// ---------------------------------------------------------------------------

// Where a successful tool call landed, so clients can render a tap-through
// to the created entity's screen.
export const LlmChatToolLinkSchema = z.object({
  entity: z.enum(["schedule", "workflowRun", "kanbanCard"]),
  id: z.string(),
});

export type LlmChatToolLink = z.infer<typeof LlmChatToolLinkSchema>;

export const LlmChatToolCallSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  summary: z.string(),
  link: LlmChatToolLinkSchema.optional(),
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

// Approve or decline a pending tool proposal surfaced via a tool_proposal
// event on the in-flight send.
export const LlmChatToolRespondRequestSchema = z.object({
  type: z.literal("llm.chat.tool.respond.request"),
  requestId: z.string(),
  chatId: z.string(),
  proposalId: z.string(),
  approve: z.boolean(),
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
  // A mutating tool wants to run; the daemon holds the send until a client
  // answers via llm.chat.tool.respond (or the proposal times out → declined).
  z.object({
    kind: z.literal("tool_proposal"),
    proposalId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
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
    link: LlmChatToolLinkSchema.optional(),
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

export const LlmChatToolRespondResponseSchema = z.object({
  type: z.literal("llm.chat.tool.respond.response"),
  payload: z.object({
    requestId: z.string(),
    // false when the proposal is unknown or already settled (timed out,
    // cancelled, or answered from another device).
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});
