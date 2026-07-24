import { z } from "zod";
import { InboxQuestionStatusSchema, StoredInboxQuestionSchema } from "./types.js";

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
