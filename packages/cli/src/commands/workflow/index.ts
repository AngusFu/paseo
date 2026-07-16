import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runBuiltinsCommand } from "./builtins.js";
import { runCreateCommand } from "./create.js";
import { runInspectCommand } from "./inspect.js";
import { runLsCommand } from "./ls.js";
import { runRmCommand } from "./rm.js";
import { runRunCommand } from "./run.js";
import { runRunsCancelCommand } from "./runs-cancel.js";
import { runRunsInspectCommand } from "./runs-inspect.js";
import { runRunsLsCommand } from "./runs-ls.js";
import { runUpdateCommand } from "./update.js";

function collectMultiple(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createWorkflowCommand(): Command {
  const workflow = new Command("workflow").description("Manage workflow definitions and runs");

  addJsonAndDaemonHostOptions(
    workflow.command("ls").description("List workflow definitions"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    workflow
      .command("inspect")
      .description("Inspect a workflow definition")
      .argument("<definitionId>", "Definition ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    workflow
      .command("create")
      .description("Create a workflow definition from a .flow.js source")
      .requiredOption("--name <name>", "Definition name")
      .option("--source-file <path>", "Path to a .flow.js file")
      .option("--source <script>", "Inline .flow.js source (alternative to --source-file)")
      .option("--id <id>", "Optional definition id")
      .option("--description <text>", "Optional description"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    workflow
      .command("update")
      .description("Update a workflow definition")
      .argument("<definitionId>", "Definition ID")
      .option("--name <name>", "Replace the definition name")
      .option("--description <text>", "Replace the description (empty string clears it)")
      .option("--source-file <path>", "Replace source from a .flow.js file")
      .option("--source <script>", "Replace source inline"),
  ).action(withOutput(runUpdateCommand));

  addJsonAndDaemonHostOptions(
    workflow
      .command("rm")
      .description("Delete a workflow definition")
      .argument("<definitionId>", "Definition ID"),
  ).action(withOutput(runRmCommand));

  addJsonAndDaemonHostOptions(
    workflow.command("builtins").description("List builtin workflow definitions"),
  ).action(withOutput(runBuiltinsCommand));

  addJsonAndDaemonHostOptions(
    workflow
      .command("run")
      .description("Dispatch a workflow run")
      .argument("<definitionId>", "Definition ID")
      .option(
        "--arg <key=value>",
        "Run argument (repeatable; value may be JSON)",
        collectMultiple,
        [],
      )
      .option("--provider <provider>", "Default provider for agent() calls")
      .option("--model <model>", "Default model for agent() calls")
      .option(
        "--thinking <id>",
        "Default thinking/effort option id for agent() calls (also --arg effort=...)",
      )
      .option("--mode <mode>", "Default provider mode for agent() calls")
      .option("--fast", "Enable Claude-style fast_mode for agent() calls")
      .option("--cwd <path>", "Working directory override")
      .option("--repo-path <path>", "Repo path hint for the run"),
  ).action(withOutput(runRunCommand));

  const runs = new Command("runs").description("Inspect and cancel workflow runs");

  addJsonAndDaemonHostOptions(runs.command("ls").description("List workflow runs")).action(
    withOutput(runRunsLsCommand),
  );

  addJsonAndDaemonHostOptions(
    runs.command("inspect").description("Inspect a workflow run").argument("<runId>", "Run ID"),
  ).action(withOutput(runRunsInspectCommand));

  addJsonAndDaemonHostOptions(
    runs.command("cancel").description("Cancel a workflow run").argument("<runId>", "Run ID"),
  ).action(withOutput(runRunsCancelCommand));

  workflow.addCommand(runs);

  return workflow;
}
