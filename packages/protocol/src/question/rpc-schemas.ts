import { z } from "zod";
import {
  InboxQuestionItemSchema,
  InboxQuestionStatusSchema,
  StoredInboxQuestionSchema,
} from "./types.js";

// New RPCs use dotted namespaces with direction suffixes (docs/rpc-namespacing.md).

export const QuestionListRequestSchema = z.object({
  type: z.literal("question.list.request"),
  requestId: z.string(),
  status: InboxQuestionStatusSchema.optional(),
  agentId: z.string().min(1).optional(),
});

export const QuestionAnswerRequestSchema = z.object({
  type: z.literal("question.answer.request"),
  requestId: z.string(),
  questionId: z.string().min(1),
  // When true, dismiss without answers. Mutually exclusive with a non-empty answers map.
  dismiss: z.boolean().optional(),
  answers: z.record(z.string(), z.string()).optional(),
});

export const QuestionCreateRequestSchema = z.object({
  type: z.literal("question.create.request"),
  requestId: z.string(),
  agentId: z.string().min(1),
  title: z.string().min(1).optional(),
  questions: z.array(InboxQuestionItemSchema).min(1),
  // Skill fallback / scripting. MCP path creates via ask_question, not this RPC.
  source: z.enum(["skill", "cli"]).optional(),
});

export const QuestionWaitRequestSchema = z.object({
  type: z.literal("question.wait.request"),
  requestId: z.string(),
  questionId: z.string().min(1),
  // Optional wall-clock deadline for this wait RPC (not the MCP tools/call clock).
  timeoutMs: z.number().int().positive().optional(),
});

export const QuestionListResponseSchema = z.object({
  type: z.literal("question.list.response"),
  payload: z.object({
    requestId: z.string(),
    questions: z.array(StoredInboxQuestionSchema),
    error: z.string().nullable(),
  }),
});

export const QuestionAnswerResponseSchema = z.object({
  type: z.literal("question.answer.response"),
  payload: z.object({
    requestId: z.string(),
    question: StoredInboxQuestionSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const QuestionCreateResponseSchema = z.object({
  type: z.literal("question.create.response"),
  payload: z.object({
    requestId: z.string(),
    question: StoredInboxQuestionSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const QuestionWaitResponseSchema = z.object({
  type: z.literal("question.wait.response"),
  payload: z.object({
    requestId: z.string(),
    question: StoredInboxQuestionSchema.nullable(),
    error: z.string().nullable(),
  }),
});
