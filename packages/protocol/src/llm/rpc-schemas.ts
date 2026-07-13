import { z } from "zod";

// Local LLM service RPCs (docs/rpc-namespacing.md). The daemon runs a small
// on-device model (node-llama-cpp sidecar) exposed as a lightweight generate
// API — independent from agents. First consumer: natural-language → cron in
// the schedule form.

// ---------------------------------------------------------------------------
// Model state
// ---------------------------------------------------------------------------

export const LlmLocalModelStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({
    status: z.literal("downloading"),
    receivedBytes: z.number(),
    totalBytes: z.number().nullable(),
  }),
  // Model file present on disk; loaded=true once the worker has it in memory.
  z.object({ status: z.literal("ready"), loaded: z.boolean() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export type LlmLocalModelState = z.infer<typeof LlmLocalModelStateSchema>;

// ---------------------------------------------------------------------------
// Requests (client → daemon)
// ---------------------------------------------------------------------------

export const LlmLocalStatusRequestSchema = z.object({
  type: z.literal("llm.local.status.request"),
  requestId: z.string(),
});

export const LlmLocalDownloadRequestSchema = z.object({
  type: z.literal("llm.local.download.request"),
  requestId: z.string(),
});

export const LlmLocalGenerateRequestSchema = z.object({
  type: z.literal("llm.local.generate.request"),
  requestId: z.string(),
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  // JSON Schema for grammar-constrained output; the response text is then
  // guaranteed to parse as JSON matching this schema.
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  maxTokens: z.number().int().positive().optional(),
  // When true, stream llm.local.generate.chunk events before the response.
  stream: z.boolean().optional(),
});

export const LlmLocalCancelRequestSchema = z.object({
  type: z.literal("llm.local.cancel.request"),
  requestId: z.string(),
  // requestId of the llm.local.generate.request to abort.
  generateRequestId: z.string(),
});

// ---------------------------------------------------------------------------
// Responses / events (daemon → client)
// ---------------------------------------------------------------------------

export const LlmLocalStatusResponseSchema = z.object({
  type: z.literal("llm.local.status.response"),
  payload: z.object({
    requestId: z.string(),
    model: LlmLocalModelStateSchema,
  }),
});

export const LlmLocalDownloadResponseSchema = z.object({
  type: z.literal("llm.local.download.response"),
  payload: z.object({
    requestId: z.string(),
    model: LlmLocalModelStateSchema,
    error: z.string().nullable(),
  }),
});

// Unsolicited push while a download is in flight (and on load/unload), so all
// connected clients can render progress without polling.
export const LlmLocalStatusUpdateSchema = z.object({
  type: z.literal("llm.local.status.update"),
  payload: z.object({
    model: LlmLocalModelStateSchema,
  }),
});

export const LlmLocalGenerateChunkSchema = z.object({
  type: z.literal("llm.local.generate.chunk"),
  payload: z.object({
    requestId: z.string(),
    text: z.string(),
  }),
});

export const LlmLocalGenerateResponseSchema = z.object({
  type: z.literal("llm.local.generate.response"),
  payload: z.object({
    requestId: z.string(),
    text: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const LlmLocalCancelResponseSchema = z.object({
  type: z.literal("llm.local.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    cancelled: z.boolean(),
  }),
});
