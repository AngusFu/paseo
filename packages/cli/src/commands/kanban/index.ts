import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runAddCommand } from "./add.js";
import { runLsCommand } from "./ls.js";
import { runUpdateCommand } from "./update.js";
import { runMoveCommand } from "./move.js";
import { runRmCommand } from "./rm.js";
import { runInspectCommand } from "./inspect.js";
import { runSourceAddCommand } from "./source-add.js";
import { runSourceLsCommand } from "./source-ls.js";
import { runSyncCommand } from "./sync.js";

function collectMultiple(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createKanbanCommand(): Command {
  const kanban = new Command("kanban").description("Manage the Kanban board");

  addJsonAndDaemonHostOptions(
    kanban
      .command("add")
      .description("Add a card to the board")
      .requiredOption("--title <title>", "Card title")
      .option("--url <url>", "Card URL")
      .option("--status <status>", "Card status (default: pending)")
      .option("--theme <theme>", "Card theme: jira, gitlab-mr, or #RRGGBB")
      .option("--label <label>", "Card label (repeatable)", collectMultiple, [])
      .option("--priority <priority>", "Card priority: low, med, high"),
  ).action(withOutput(runAddCommand));

  addJsonAndDaemonHostOptions(kanban.command("ls").description("List cards")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    kanban
      .command("update")
      .description("Update a card in place")
      .argument("<cardId>", "Card ID")
      .option("--title <title>", "Replace the card title")
      .option("--url <url>", "Replace the card URL")
      .option("--status <status>", "Replace the card status")
      .option("--theme <theme>", "Replace the card theme: jira, gitlab-mr, or #RRGGBB")
      .option("--label <label>", "Replace the card labels (repeatable)", collectMultiple, [])
      .option("--priority <priority>", "Replace the card priority: low, med, high"),
  ).action(withOutput(runUpdateCommand));

  addJsonAndDaemonHostOptions(
    kanban
      .command("move")
      .description("Move a card to a new column")
      .argument("<cardId>", "Card ID")
      .requiredOption("--status <status>", "Target column status")
      .option("--order <order>", "Sort position within the column"),
  ).action(withOutput(runMoveCommand));

  addJsonAndDaemonHostOptions(
    kanban.command("rm").description("Delete a card").argument("<cardId>", "Card ID"),
  ).action(withOutput(runRmCommand));

  addJsonAndDaemonHostOptions(
    kanban.command("inspect").description("Inspect a card").argument("<cardId>", "Card ID"),
  ).action(withOutput(runInspectCommand));

  const source = new Command("source").description("Manage Kanban card sources");

  addJsonAndDaemonHostOptions(
    source
      .command("add")
      .description("Add a card source")
      .requiredOption("--kind <kind>", "Source kind: jira or gitlab")
      .requiredOption("--name <name>", "Source name")
      .requiredOption("--base-url <url>", "Source instance base URL")
      .requiredOption("--query <query>", "JQL (jira) or MR filter (gitlab)")
      .option("--poll-every-sec <n>", "Poll interval in seconds")
      .option("--token-ref <envVar>", "Environment variable holding the auth token"),
  ).action(withOutput(runSourceAddCommand));

  addJsonAndDaemonHostOptions(source.command("ls").description("List card sources")).action(
    withOutput(runSourceLsCommand),
  );

  kanban.addCommand(source);

  addJsonAndDaemonHostOptions(
    kanban
      .command("sync")
      .description("Sync cards from a source")
      .argument("<sourceId>", "Source ID"),
  ).action(withOutput(runSyncCommand));

  return kanban;
}
