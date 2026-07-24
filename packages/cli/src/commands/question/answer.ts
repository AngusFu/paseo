import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectQuestionClient,
  toQuestionCommandError,
  type QuestionCommandOptions,
} from "./shared.js";

interface QuestionAnswerRow {
  id: string;
  status: string;
  answers: string;
}

const answerSchema: OutputSchema<QuestionAnswerRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ANSWERS", field: "answers", width: 40 },
  ],
};

function parseAnswerPairs(pairs: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw {
        code: "INVALID_ANSWER",
        message: `--answer must be header=value (got "${pair}")`,
      };
    }
    const header = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!header || !value) {
      throw {
        code: "INVALID_ANSWER",
        message: `--answer must be header=value (got "${pair}")`,
      };
    }
    answers[header] = value;
  }
  return answers;
}

export async function runAnswerCommand(
  questionId: string,
  options: QuestionCommandOptions & {
    answer?: string[];
    dismiss?: boolean;
  },
  _command: Command,
): Promise<SingleResult<QuestionAnswerRow>> {
  const { client } = await connectQuestionClient(options.host);
  try {
    const dismiss = options.dismiss === true;
    const answers = parseAnswerPairs(options.answer ?? []);
    if (!dismiss && Object.keys(answers).length === 0) {
      throw {
        code: "MISSING_ANSWER",
        message: "Provide --answer header=value (repeatable) or --dismiss",
      };
    }
    const payload = await client.questionAnswer({
      questionId,
      ...(dismiss ? { dismiss: true } : { answers }),
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
      schema: answerSchema,
    };
  } catch (error) {
    throw toQuestionCommandError("QUESTION_ANSWER_FAILED", "answer question", error);
  } finally {
    await client.close().catch(() => {});
  }
}
