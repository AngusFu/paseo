import { Command } from "commander";
import { runFeaturesCommand } from "./features.js";
import { runInspectCommand } from "./inspect.js";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available providers, status, and mode ids"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name (claude, codex, cursor, opencode, …)")
      .option("--thinking", "Include thinking/effort option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("features")
      .description("List draft features (fast mode, plan mode, …) for a provider/model")
      .argument("<provider>", "Provider name (claude, codex, cursor, opencode, …)")
      .option("--cwd <path>", "Working directory used for draft feature discovery", process.cwd())
      .option("--model <id>", "Model id (features are often model-gated)")
      .option("--mode <id>", "Mode id when feature discovery depends on mode")
      .option("--thinking <id>", "Thinking/effort option id when discovery depends on it"),
  ).action(withOutput(runFeaturesCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("inspect")
      .description("Dump enabled providers with modes, models, and thinking ids")
      .option("--cwd <path>", "Working directory for the provider snapshot", process.cwd())
      .option("--provider <id>", "Limit output to one provider")
      .option("--all", "Include disabled providers (default: enabled only)"),
  ).action(withOutput(runInspectCommand));

  return provider;
}
