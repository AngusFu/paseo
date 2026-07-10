import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  assertCommandSchedulesSupported,
  connectScheduleClient,
  parseScheduleUpdateInput,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  noMaxRuns?: boolean;
  expiresIn?: string;
  noExpiresIn?: boolean;
  command?: string;
  env?: string[];
  clearEnv?: boolean;
  timeout?: string;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const input = parseScheduleUpdateInput({
    id,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    clearMaxRuns: options.noMaxRuns,
    clearExpires: options.noExpiresIn,
    command: options.command,
    env: options.env,
    clearEnv: options.clearEnv,
    timeout: options.timeout,
  });
  const { client } = await connectScheduleClient(options.host);
  try {
    if (input.commandConfig !== undefined) {
      assertCommandSchedulesSupported(client);
    }
    const payload = await client.scheduleUpdate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
