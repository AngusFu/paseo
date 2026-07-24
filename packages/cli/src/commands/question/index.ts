import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runAnswerCommand } from "./answer.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runWaitCommand } from "./wait.js";

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
      .command("create")
      .description("Create an inbox question (skill/CLI fallback after MCP timeout)")
      .requiredOption("--agent <agentId>", "Agent id that owns the question")
      .requiredOption(
        "--questions <json>",
        "JSON array of ask_question items (question/header/options…)",
      )
      .option("--title <title>", "Optional title")
      .option("--source <source>", "skill or cli (default: cli)", "cli"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    question
      .command("wait")
      .description("Wait until an inbox question is answered or dismissed")
      .argument("<questionId>", "Question ID (qst_…)")
      .option("--timeout <duration>", "Max wait (e.g. 30m, 600s); default is daemon/client limit"),
  ).action(withOutput(runWaitCommand));

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
