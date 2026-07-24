import type { Command } from "commander";
import { InboxQuestionStatusSchema } from "@getpaseo/protocol/question/types";
import type { ListResult, OutputSchema } from "../../output/index.js";
import {
  connectQuestionClient,
  toQuestionCommandError,
  type QuestionCommandOptions,
} from "./shared.js";

export interface QuestionRow {
  id: string;
  status: string;
  agentId: string;
  source: string;
  title: string;
  createdAt: string;
}

const questionSchema: OutputSchema<QuestionRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "AGENT", field: "agentId", width: 36 },
    { header: "SOURCE", field: "source", width: 8 },
    { header: "TITLE", field: "title", width: 28 },
    { header: "CREATED", field: "createdAt", width: 24 },
  ],
};

export async function runLsCommand(
  options: QuestionCommandOptions & {
    status?: string;
    all?: boolean;
    agent?: string;
  },
  _command: Command,
): Promise<ListResult<QuestionRow>> {
  const { client } = await connectQuestionClient(options.host);
  try {
    let status: "pending" | "answered" | "dismissed" | "expired" | undefined;
    if (!options.all) {
      const parsed = InboxQuestionStatusSchema.safeParse(options.status ?? "pending");
      if (!parsed.success) {
        throw {
          code: "INVALID_STATUS",
          message: `--status must be one of: ${InboxQuestionStatusSchema.options.join(", ")}`,
        };
      }
      status = parsed.data;
    }
    const payload = await client.questionList({
      ...(status ? { status } : {}),
      ...(options.agent ? { agentId: options.agent } : {}),
    });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.questions.map((question) => ({
        id: question.id,
        status: question.status,
        agentId: question.agentId,
        source: question.source,
        title: question.title ?? question.questions[0]?.header ?? "",
        createdAt: question.createdAt,
      })),
      schema: questionSchema,
    };
  } catch (error) {
    throw toQuestionCommandError("QUESTION_LIST_FAILED", "list questions", error);
  } finally {
    await client.close().catch(() => {});
  }
}
