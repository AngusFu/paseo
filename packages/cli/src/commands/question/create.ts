import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectQuestionClient,
  toQuestionCommandError,
  type QuestionCommandOptions,
} from "./shared.js";

interface QuestionCreateRow {
  id: string;
  status: string;
  agentId: string;
  source: string;
}

const createSchema: OutputSchema<QuestionCreateRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 14 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "AGENT", field: "agentId", width: 36 },
    { header: "SOURCE", field: "source", width: 8 },
  ],
};

export async function runCreateCommand(
  options: QuestionCommandOptions & {
    agent?: string;
    questions?: string;
    title?: string;
    source?: string;
  },
  _command: Command,
): Promise<SingleResult<QuestionCreateRow>> {
  const { client } = await connectQuestionClient(options.host);
  try {
    if (!options.agent?.trim()) {
      throw {
        code: "MISSING_AGENT",
        message: "--agent is required",
      };
    }
    if (!options.questions?.trim()) {
      throw {
        code: "MISSING_QUESTIONS",
        message: "--questions is required",
      };
    }
    let questions: unknown;
    try {
      questions = JSON.parse(options.questions);
    } catch {
      throw {
        code: "INVALID_QUESTIONS",
        message: "--questions must be a JSON array of ask_question items",
      };
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      throw {
        code: "INVALID_QUESTIONS",
        message: "--questions must be a non-empty JSON array",
      };
    }
    const source =
      options.source === "skill" || options.source === "cli" ? options.source : ("cli" as const);
    const payload = await client.questionCreate({
      agentId: options.agent,
      questions: questions as Parameters<typeof client.questionCreate>[0]["questions"],
      ...(options.title ? { title: options.title } : {}),
      source,
    });
    if (payload.error || !payload.question) {
      throw new Error(payload.error ?? "No question returned");
    }
    return {
      type: "single",
      data: {
        id: payload.question.id,
        status: payload.question.status,
        agentId: payload.question.agentId,
        source: payload.question.source,
      },
      schema: createSchema,
    };
  } catch (error) {
    throw toQuestionCommandError("QUESTION_CREATE_FAILED", "create question", error);
  } finally {
    await client.close().catch(() => {});
  }
}
