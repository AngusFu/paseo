import { z } from "zod";

export const InboxQuestionStatusSchema = z.enum(["pending", "answered", "dismissed", "expired"]);
export type InboxQuestionStatus = z.infer<typeof InboxQuestionStatusSchema>;

export const InboxQuestionSourceSchema = z.enum(["mcp", "skill", "cli", "native_mirror"]);
export type InboxQuestionSource = z.infer<typeof InboxQuestionSourceSchema>;

export const InboxQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type InboxQuestionOption = z.infer<typeof InboxQuestionOptionSchema>;

export const InboxQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z.array(InboxQuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  allowEmpty: z.boolean().optional(),
  placeholder: z.string().optional(),
});
export type InboxQuestionItem = z.infer<typeof InboxQuestionItemSchema>;

export const StoredInboxQuestionSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1).optional(),
  /** When the row left `pending` via dismiss/expire (for Closed retention prune). */
  closedAt: z.string().min(1).optional(),
  status: InboxQuestionStatusSchema,
  title: z.string().min(1).optional(),
  questions: z.array(InboxQuestionItemSchema),
  answers: z.record(z.string(), z.string()).optional(),
  source: InboxQuestionSourceSchema,
  mcpRequestId: z.string().min(1).optional(),
});
export type StoredInboxQuestion = z.infer<typeof StoredInboxQuestionSchema>;
