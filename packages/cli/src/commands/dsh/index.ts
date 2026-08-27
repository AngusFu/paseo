import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runLsCommand } from "./ls.js";
import { runPermissionCommand } from "./permission.js";
import { runRunCommand } from "./run.js";
import { runSendCommand } from "./send.js";
import { runStatusCommand } from "./status.js";

function addDshHostOption(command: Command): Command {
  return command.option(
    "--dsh-host <baseUrl>",
    "DSH Web base URL override (forwarded to daemon), e.g. http://127.0.0.1:64167",
  );
}

export function createDshCommand(): Command {
  const dsh = new Command("dsh").description(
    "Control Desktop-managed DeepSeek Harness sessions via the daemon proxy",
  );

  addDshHostOption(
    addJsonAndDaemonHostOptions(
      dsh.command("status").description("Check whether DSH Web is reachable"),
    ),
  ).action(withOutput(runStatusCommand));

  addDshHostOption(
    addJsonAndDaemonHostOptions(
      dsh
        .command("ls")
        .description("List DSH sessions (excludes blank/subagent unless --all)")
        .option("-a, --all", "include blank sessions and subagent-origin rows")
        .option("--cwd <path>", "filter by exact working directory"),
    ),
  ).action(withOutput(runLsCommand));

  addDshHostOption(
    addJsonAndDaemonHostOptions(
      dsh
        .command("run")
        .description("Create a DSH session and queue a prompt")
        .argument("<prompt>", "task/prompt for the session")
        .option("--workspace <id>", "attach to an existing DSH workspace id")
        .option("--cwd <path>", "working directory (default: cwd; ignored with --workspace)")
        .option("--agent-preset <id>", "agent preset (standard/code/minimal/cordis)")
        .option(
          "--permission <preset>",
          "permission preset: read-only | workspace-write | danger-full-access",
        ),
    ),
  ).action(withOutput(runRunCommand));

  addDshHostOption(
    addJsonAndDaemonHostOptions(
      dsh
        .command("send")
        .description("Queue a follow-up prompt on an existing session")
        .argument("<session-id>", "full session id or short prefix")
        .argument("<prompt>", "message text"),
    ),
  ).action(withOutput(runSendCommand));

  addDshHostOption(
    addJsonAndDaemonHostOptions(
      dsh
        .command("permission")
        .description("Set a session permission preset")
        .argument("<session-id>", "full session id or short prefix")
        .argument("<preset>", "read-only | workspace-write | danger-full-access"),
    ),
  ).action(withOutput(runPermissionCommand));

  return dsh;
}
