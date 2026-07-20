import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleTarget,
  UpdateScheduleCommandConfig,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";

export interface ScheduleCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectScheduleClient(
  host: string | undefined,
): Promise<{ client: ScheduleDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = (await connectToDaemon({
      host,
    })) as unknown as ScheduleDaemonClient;
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function assertCommandSchedulesSupported(client: ScheduleDaemonClient): void {
  const features = client.getLastServerInfoMessage()?.features;
  if (!features?.commandSchedules) {
    throw {
      code: "UNSUPPORTED_COMMAND_SCHEDULES",
      message: "daemon does not support command schedules; update the host",
    } satisfies CommandError;
  }
}

export function toScheduleCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export async function requireNewAgentSchedule(
  client: ScheduleDaemonClient,
  id: string,
): Promise<void> {
  const payload = await client.scheduleInspect({ id });
  // Heartbeats (agent targets) are managed through the heartbeat commands; the
  // schedule commands operate on new-agent and command targets.
  if (payload.error || !payload.schedule || payload.schedule.target.type === "agent") {
    throw new Error(payload.error ?? `Schedule not found: ${id}`);
  }
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    const timezoneSuffix = cadence.timezone ? ` (${cadence.timezone})` : "";
    return `cron:${cadence.expression}${timezoneSuffix}`;
  }
  return `every:${formatDurationMs(cadence.everyMs)}`;
}

export function formatTarget(target: ScheduleTarget | ScheduleListItem["target"]): string {
  if (target.type === "self") {
    return `self:${target.agentId.slice(0, 7)}`;
  }
  if (target.type === "agent") {
    return `agent:${target.agentId.slice(0, 7)}`;
  }
  if (target.type === "command") {
    return `command:${target.command}`;
  }
  const modelSuffix = target.config.model ? `/${target.config.model}` : "";
  return `new-agent:${target.config.provider}${modelSuffix}`;
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remainingMs = durationMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours > 0) {
    parts.push(`${hours}h`);
    remainingMs -= hours * 60 * 60 * 1000;
  }
  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remainingMs -= minutes * 60 * 1000;
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join("");
}

function resolveScheduleTarget(args: {
  targetValue: string | undefined;
  hasExplicitNewAgentOption: boolean;
  createNewAgentTarget: () => ScheduleTarget;
}): ScheduleTarget {
  const { targetValue, hasExplicitNewAgentOption, createNewAgentTarget } = args;
  if (!targetValue) {
    return createNewAgentTarget();
  }

  if (targetValue === "new-agent") {
    return createNewAgentTarget();
  }

  if (hasExplicitNewAgentOption) {
    throw {
      code: "INVALID_TARGET",
      message: "--provider/--mode can only be used with a new-agent target",
      details: "Use --target new-agent or omit --target to create a new agent schedule",
    } satisfies CommandError;
  }

  if (targetValue === "self") {
    // COMPAT(scheduleSelfTarget): heartbeat creation moved to `paseo heartbeat create`.
    // Added in v0.2.0; remove after 2027-01-17.
    const currentAgentId = process.env.PASEO_AGENT_ID?.trim();
    if (!currentAgentId) {
      throw {
        code: "INVALID_TARGET",
        message: "--target self requires running inside a Paseo agent",
      } satisfies CommandError;
    }
    return { type: "self", agentId: currentAgentId };
  }

  return { type: "agent", agentId: targetValue };
}

export function parseScheduleCreateInput(options: {
  prompt?: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  cwd?: string;
  host?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
  command?: string;
  env?: string[];
  timeout?: string;
}): CreateScheduleInput {
  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  if (!cadence) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const cwdInput = options.cwd?.trim();
  if (options.host !== undefined && !cwdInput) {
    throw {
      code: "MISSING_CWD",
      message:
        "--cwd is required when --host is specified (the local working directory will not exist on the remote daemon)",
    } satisfies CommandError;
  }

  const runOnCreate = resolveRunOnCreate(options.runNow, cadence.type);
  const maxRuns = parseCreateMaxRuns(options.maxRuns);
  const expiresAt = parseCreateExpiresAt(options.expiresIn);
  const name = options.name?.trim();

  // Command target: the command string doubles as the prompt (the daemon derives
  // the prompt from target.command). The <prompt> positional is unused here.
  const target =
    options.command !== undefined
      ? buildCommandCreateTarget(options, cwdInput)
      : buildAgentCreateTarget(options, cwdInput);
  const prompt = target.type === "command" ? target.command : requireCreatePrompt(options.prompt);

  return {
    prompt,
    cadence,
    target,
    runOnCreate,
    ...(name ? { name } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function parseCreateMaxRuns(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parsePositiveInt(value, "--max-runs");
}

function parseCreateExpiresAt(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : new Date(Date.now() + parseDuration(value)).toISOString();
}

function requireCreatePrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim() ?? "";
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildCommandCreateTarget(
  options: {
    command?: string;
    target?: string;
    provider?: string;
    mode?: string;
    env?: string[];
    timeout?: string;
  },
  cwdInput: string | undefined,
): ScheduleTarget {
  if (
    options.target !== undefined ||
    options.provider !== undefined ||
    options.mode !== undefined
  ) {
    throw {
      code: "CONFLICTING_TARGET",
      message: "--command cannot be combined with --target/--provider/--mode",
    } satisfies CommandError;
  }
  const command = options.command?.trim() ?? "";
  if (!command) {
    throw {
      code: "INVALID_COMMAND",
      message: "--command cannot be empty",
    } satisfies CommandError;
  }
  const env = parseEnvEntries(options.env);
  const timeoutMs =
    options.timeout === undefined ? undefined : parsePositiveInt(options.timeout, "--timeout");
  return {
    type: "command",
    command,
    cwd: cwdInput ?? process.cwd(),
    ...(env ? { env } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function buildAgentCreateTarget(
  options: { target?: string; provider?: string; mode?: string },
  cwdInput: string | undefined,
): ScheduleTarget {
  const targetValue = options.target?.trim();
  const modeId = options.mode?.trim();
  const hasExplicitNewAgentOption = options.provider !== undefined || options.mode !== undefined;
  const createNewAgentTarget = (): ScheduleTarget => {
    const resolvedProviderModel = resolveProviderAndModel({
      provider: options.provider,
    });
    return {
      type: "new-agent",
      config: {
        provider: resolvedProviderModel.provider,
        cwd: cwdInput ?? process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(modeId ? { modeId } : {}),
      },
    };
  };
  return resolveScheduleTarget({
    targetValue,
    hasExplicitNewAgentOption,
    createNewAgentTarget,
  });
}

function resolveRunOnCreate(
  runNow: boolean | undefined,
  _cadenceType: ScheduleCadence["type"],
): boolean {
  return runNow ?? false;
}

export interface ScheduleUpdateOptionsInput {
  id: string;
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
  expiresIn?: string;
  clearMaxRuns?: boolean;
  clearExpires?: boolean;
  command?: string;
  env?: string[];
  clearEnv?: boolean;
  timeout?: string;
}

export function parseScheduleUpdateInput(options: ScheduleUpdateOptionsInput): UpdateScheduleInput {
  const id = options.id.trim();
  if (!id) {
    throw {
      code: "INVALID_SCHEDULE_ID",
      message: "Schedule id cannot be empty",
    } satisfies CommandError;
  }

  const { newAgentConfig, commandConfig } = resolveUpdateTargetPatches(options);
  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  const maxRuns = parseUpdateMaxRuns(options);
  const expiresAt = parseUpdateExpiresAt(options);
  const name = parseUpdateName(options);
  const prompt = parseUpdatePrompt(options);

  if (
    name === undefined &&
    prompt === undefined &&
    cadence === undefined &&
    newAgentConfig === undefined &&
    commandConfig === undefined &&
    maxRuns === undefined &&
    expiresAt === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
    ...(commandConfig !== undefined ? { commandConfig } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseCadenceFromFlags(
  every: string | undefined,
  cron: string | undefined,
  timezone: string | undefined,
): ScheduleCadence | undefined {
  if (every !== undefined && cron !== undefined) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify at most one of --every or --cron",
    } satisfies CommandError;
  }
  const trimmedTimeZone = parseTimeZoneFlag(timezone);
  if (trimmedTimeZone !== undefined && cron === undefined) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone can only be used with --cron",
    } satisfies CommandError;
  }
  if (every !== undefined) {
    return { type: "cron", expression: compileEveryPresetToCron(every) };
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron.trim(),
      ...(trimmedTimeZone ? { timezone: trimmedTimeZone } : {}),
    };
  }
  return undefined;
}

export function compileEveryPresetToCron(value: string): string {
  const durationMs = parseDuration(value);
  const cron = everyMsToFiveFieldCron(durationMs);
  if (cron) {
    return cron;
  }

  throw {
    code: "UNREPRESENTABLE_CADENCE",
    message: `${value} cannot be represented faithfully by five-field cron`,
    details: "Use --cron for calendar schedules",
  } satisfies CommandError;
}

function parseTimeZoneFlag(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) {
    return undefined;
  }
  const trimmed = timeZone.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function parseUpdateMaxRuns(options: ScheduleUpdateOptionsInput): number | null | undefined {
  if (options.maxRuns !== undefined && options.clearMaxRuns) {
    throw {
      code: "CONFLICTING_MAX_RUNS",
      message: "Use either --max-runs <n> or --no-max-runs, not both",
    } satisfies CommandError;
  }
  if (options.clearMaxRuns) {
    return null;
  }
  if (options.maxRuns !== undefined) {
    return parsePositiveInt(options.maxRuns, "--max-runs");
  }
  return undefined;
}

function parseUpdateExpiresAt(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.expiresIn !== undefined && options.clearExpires) {
    throw {
      code: "CONFLICTING_EXPIRES",
      message: "Use either --expires-in <duration> or --no-expires-in, not both",
    } satisfies CommandError;
  }
  if (options.clearExpires) {
    return null;
  }
  if (options.expiresIn !== undefined) {
    return new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();
  }
  return undefined;
}

function parseUpdateName(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.name === undefined) {
    return undefined;
  }
  const trimmed = options.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUpdatePrompt(options: ScheduleUpdateOptionsInput): string | undefined {
  if (options.prompt === undefined) {
    return undefined;
  }
  const trimmed = options.prompt.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "--prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildNewAgentConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleNewAgentConfig | undefined {
  const patch: UpdateScheduleNewAgentConfig = {};
  if (options.provider !== undefined || options.model !== undefined) {
    const resolved = resolveProviderAndModel({
      provider: options.provider,
      model: options.model,
    });
    patch.provider = resolved.provider;
    if (resolved.model !== undefined) {
      patch.model = resolved.model;
    }
  }
  if (options.mode !== undefined) {
    const trimmed = options.mode.trim();
    patch.modeId = trimmed.length > 0 ? trimmed : null;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function resolveUpdateTargetPatches(options: ScheduleUpdateOptionsInput): {
  newAgentConfig?: UpdateScheduleNewAgentConfig;
  commandConfig?: UpdateScheduleCommandConfig;
} {
  const hasCommandFlags =
    options.command !== undefined ||
    (options.env !== undefined && options.env.length > 0) ||
    options.clearEnv === true ||
    options.timeout !== undefined;
  const hasNewAgentFlags =
    options.provider !== undefined || options.model !== undefined || options.mode !== undefined;
  if (hasCommandFlags && hasNewAgentFlags) {
    throw {
      code: "CONFLICTING_TARGET",
      message: "--command/--env/--timeout cannot be combined with --provider/--model/--mode",
    } satisfies CommandError;
  }
  // --cwd routes to the command config when command flags are present, otherwise
  // to the new-agent config (its existing meaning).
  if (hasCommandFlags) {
    return { commandConfig: buildCommandConfigPatch(options) };
  }
  return { newAgentConfig: buildNewAgentConfigPatch(options) };
}

function buildCommandConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleCommandConfig | undefined {
  const patch: UpdateScheduleCommandConfig = {};
  if (options.command !== undefined) {
    const trimmed = options.command.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_COMMAND",
        message: "--command cannot be empty",
      } satisfies CommandError;
    }
    patch.command = trimmed;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  if (options.clearEnv) {
    if (options.env !== undefined && options.env.length > 0) {
      throw {
        code: "CONFLICTING_ENV",
        message: "Use either --env KEY=VALUE or --clear-env, not both",
      } satisfies CommandError;
    }
    patch.env = null;
  } else {
    const env = parseEnvEntries(options.env);
    if (env !== undefined) {
      patch.env = env;
    }
  }
  if (options.timeout !== undefined) {
    patch.timeoutMs = parsePositiveInt(options.timeout, "--timeout");
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parseEnvEntries(entries: string[] | undefined): Record<string, string> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw {
        code: "INVALID_ENV",
        message: `--env must be KEY=VALUE (got "${entry}")`,
      } satisfies CommandError;
    }
    const key = entry.slice(0, eq).trim();
    if (!key) {
      throw {
        code: "INVALID_ENV",
        message: `--env key cannot be empty (got "${entry}")`,
      } satisfies CommandError;
    }
    env[key] = entry.slice(eq + 1);
  }
  return env;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export interface ScheduleRow {
  id: string;
  name: string | null;
  cadence: string;
  target: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function toScheduleRow(schedule: ScheduleListItem | ScheduleRecord): ScheduleRow {
  return {
    id: schedule.id,
    name: schedule.name,
    cadence: formatCadence(schedule.cadence),
    target: formatTarget(schedule.target),
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
  };
}
