import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runAnswerCommand } from "./answer.js";
import { runLsCommand } from "./ls.js";

function collectAnswer(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createQuestionCommand(): Command {
  const question = new Command("question").description(
    "Manage the Question Inbox (MCP ask_question persistence)",
  );

  addJsonAndDaemonHostOptions(
    question
      .command("ls")
      .description("List inbox questions")
      .option("--status <status>", "Filter by status (default: pending)", "pending")
      .option("--all", "List all statuses (overrides --status)")
      .option("--agent <agentId>", "Filter by agent id"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    question
      .command("answer")
      .description("Answer or dismiss an inbox question")
      .argument("<questionId>", "Question ID (qst_…)")
      .option(
        "--answer <header=value>",
        "Answer for a question header (repeatable)",
        collectAnswer,
        [],
      )
      .option("--dismiss", "Dismiss without answering"),
  ).action(withOutput(runAnswerCommand));

  return question;
}
