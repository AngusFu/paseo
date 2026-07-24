import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { parseDuration } from "../../utils/duration.js";
import {
  connectQuestionClient,
  toQuestionCommandError,
  type QuestionCommandOptions,
} from "./shared.js";

interface QuestionWaitRow {
  id: string;
  status: string;
  answers: string;
}

const waitSchema: OutputSchema<QuestionWaitRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ANSWERS", field: "answers", width: 40 },
  ],
};

export async function runWaitCommand(
  questionId: string,
  options: QuestionCommandOptions & {
    timeout?: string;
  },
  _command: Command,
): Promise<SingleResult<QuestionWaitRow>> {
  const { client } = await connectQuestionClient(options.host);
  try {
    let timeoutMs: number | undefined;
    if (options.timeout) {
      try {
        timeoutMs = parseDuration(options.timeout);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw {
          code: "INVALID_TIMEOUT",
          message: `Invalid --timeout: ${message}`,
        };
      }
      if (timeoutMs <= 0) {
        throw {
          code: "INVALID_TIMEOUT",
          message: "--timeout must be positive",
        };
      }
    }
    const payload = await client.questionWait({
      questionId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (payload.error || !payload.question) {
      throw new Error(payload.error ?? "No question returned");
    }
    return {
      type: "single",
      data: {
        id: payload.question.id,
        status: payload.question.status,
        answers: JSON.stringify(payload.question.answers ?? {}),
      },
      schema: waitSchema,
    };
  } catch (error) {
    throw toQuestionCommandError("QUESTION_WAIT_FAILED", "wait for question", error);
  } finally {
    await client.close().catch(() => {});
  }
}
