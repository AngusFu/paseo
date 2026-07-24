import type { Command } from "commander";
import type { StoredInboxQuestion } from "@getpaseo/protocol/question/types";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { parseDuration } from "../../utils/duration.js";
import {
  connectQuestionClient,
  toQuestionCommandError,
  type QuestionCommandOptions,
} from "./shared.js";
import { questionWaitSocketAvailable, waitInboxQuestionOverSocket } from "./wait-socket.js";

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

function toWaitRow(question: StoredInboxQuestion): QuestionWaitRow {
  return {
    id: question.id,
    status: question.status,
    answers: JSON.stringify(question.answers ?? {}),
  };
}

export async function runWaitCommand(
  questionId: string,
  options: QuestionCommandOptions & {
    timeout?: string;
  },
  _command: Command,
): Promise<SingleResult<QuestionWaitRow>> {
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

  // Prefer the local wait socket when available (no WS hello). Explicit --host
  // means the caller wants a remote/named daemon, so keep the WS path.
  if (!options.host && questionWaitSocketAvailable()) {
    try {
      const question = await waitInboxQuestionOverSocket({
        questionId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return { type: "single", data: toWaitRow(question), schema: waitSchema };
    } catch {
      // Fall through to WS wait — socket may be stale or mid-restart.
    }
  }

  const { client } = await connectQuestionClient(options.host);
  try {
    const payload = await client.questionWait({
      questionId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (payload.error || !payload.question) {
      throw new Error(payload.error ?? "No question returned");
    }
    return {
      type: "single",
      data: toWaitRow(payload.question),
      schema: waitSchema,
    };
  } catch (error) {
    throw toQuestionCommandError("QUESTION_WAIT_FAILED", "wait for question", error);
  } finally {
    await client.close().catch(() => {});
  }
}
