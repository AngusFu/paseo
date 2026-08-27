import { z } from "zod";
import { DshSessionRowSchema, DshStatusSchema } from "./types.js";

// Daemon → DeepSeek Harness HTTP proxy (docs/rpc-namespacing.md + docs/deepseek-harness.md).

export const DshStatusRequestSchema = z.object({
  type: z.literal("dsh.status.request"),
  requestId: z.string(),
  /** Optional override; otherwise daemon discovers Desktop port / env / loopback. */
  baseUrl: z.string().min(1).optional(),
});

export const DshSessionListRequestSchema = z.object({
  type: z.literal("dsh.session.list.request"),
  requestId: z.string(),
  baseUrl: z.string().min(1).optional(),
  /** Include blank sessions and subagent-origin rows. */
  includeAll: z.boolean().optional(),
});

export const DshSessionCreateRequestSchema = z.object({
  type: z.literal("dsh.session.create.request"),
  requestId: z.string(),
  baseUrl: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  agentPreset: z.string().min(1).optional(),
  /** read-only | workspace-write | danger-full-access (aliases normalized on server). */
  permission: z.string().min(1).optional(),
  /** First user prompt; queued after create. */
  prompt: z.string().min(1).optional(),
});

export const DshSessionPromptRequestSchema = z.object({
  type: z.literal("dsh.session.prompt.request"),
  requestId: z.string(),
  baseUrl: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  mode: z.enum(["queue", "steer"]).optional(),
});

export const DshSessionSetPermissionRequestSchema = z.object({
  type: z.literal("dsh.session.set_permission.request"),
  requestId: z.string(),
  baseUrl: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  permission: z.string().min(1),
});

export const DshStatusResponseSchema = z.object({
  type: z.literal("dsh.status.response"),
  payload: z.object({
    requestId: z.string(),
    status: DshStatusSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const DshSessionListResponseSchema = z.object({
  type: z.literal("dsh.session.list.response"),
  payload: z.object({
    requestId: z.string(),
    baseUrl: z.string().nullable(),
    sessions: z.array(DshSessionRowSchema),
    error: z.string().nullable(),
  }),
});

export const DshSessionCreateResponseSchema = z.object({
  type: z.literal("dsh.session.create.response"),
  payload: z.object({
    requestId: z.string(),
    baseUrl: z.string().nullable(),
    sessionId: z.string().nullable(),
    agentPreset: z.string().nullable(),
    permission: z.string().nullable(),
    accepted: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
});

export const DshSessionPromptResponseSchema = z.object({
  type: z.literal("dsh.session.prompt.response"),
  payload: z.object({
    requestId: z.string(),
    baseUrl: z.string().nullable(),
    sessionId: z.string().nullable(),
    accepted: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
});

export const DshSessionSetPermissionResponseSchema = z.object({
  type: z.literal("dsh.session.set_permission.response"),
  payload: z.object({
    requestId: z.string(),
    baseUrl: z.string().nullable(),
    sessionId: z.string().nullable(),
    permission: z.string().nullable(),
    text: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
