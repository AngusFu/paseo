import { z } from "zod";

/** Compact DSH session row for `paseo dsh ls` / daemon proxy. */
export const DshSessionRowSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().nullable(),
  status: z.enum(["running", "idle", "pending"]),
  blank: z.boolean(),
  cwd: z.string().nullable(),
  agentPreset: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  updatedAt: z.number().nullable(),
  turns: z.number().nullable(),
});

export type DshSessionRow = z.infer<typeof DshSessionRowSchema>;

export const DshStatusSchema = z.object({
  running: z.boolean(),
  baseUrl: z.string().nullable(),
  port: z.number().int().positive().nullable(),
});

export type DshStatus = z.infer<typeof DshStatusSchema>;
