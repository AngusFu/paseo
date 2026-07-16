import { readFileSync } from "node:fs";
import type {
  CreateWorkflowDefinitionInput,
  DispatchWorkflowRunInput,
  UpdateWorkflowDefinitionInput,
  WorkflowDefinition,
  WorkflowRun,
} from "@getpaseo/protocol/workflow/types";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type { WorkflowDaemonClient } from "./types.js";

export interface WorkflowCommandOptions extends CommandOptions {
  host?: string;
}

export interface WorkflowDefinitionRow {
  id: string;
  name: string;
  builtin: string;
  updatedAt: string;
  description: string;
}

export interface WorkflowRunRow {
  id: string;
  definitionId: string;
  status: string;
  queuedAt: string;
  startedAt: string;
  endedAt: string;
  cwd: string;
}

export async function connectWorkflowClient(
  host: string | undefined,
): Promise<{ client: WorkflowDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = (await connectToDaemon({ host })) as unknown as WorkflowDaemonClient;
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

export function assertWorkflowSupported(client: WorkflowDaemonClient): void {
  const features = client.getLastServerInfoMessage()?.features;
  if (!features?.workflow) {
    throw {
      code: "UNSUPPORTED_WORKFLOW",
      message: "daemon does not support workflows; update the host",
    } satisfies CommandError;
  }
}

export function toWorkflowCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export function readSourceFile(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_SOURCE_FILE",
      message: "--source-file cannot be empty",
    } satisfies CommandError;
  }
  try {
    const source = readFileSync(trimmed, "utf8");
    if (!source.trim()) {
      throw {
        code: "INVALID_SOURCE_FILE",
        message: `--source-file is empty: ${trimmed}`,
      } satisfies CommandError;
    }
    return source;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "INVALID_SOURCE_FILE",
      message: `Failed to read --source-file: ${message}`,
    } satisfies CommandError;
  }
}

export function parseWorkflowCreateInput(options: {
  name?: string;
  sourceFile?: string;
  source?: string;
  id?: string;
  description?: string;
}): CreateWorkflowDefinitionInput {
  const name = options.name?.trim() ?? "";
  if (!name) {
    throw {
      code: "INVALID_NAME",
      message: "--name cannot be empty",
    } satisfies CommandError;
  }
  const source =
    options.sourceFile !== undefined
      ? readSourceFile(options.sourceFile)
      : (options.source?.trim() ?? "");
  if (!source) {
    throw {
      code: "INVALID_SOURCE",
      message: "provide --source-file <path> or --source <script>",
    } satisfies CommandError;
  }
  return {
    name,
    source,
    ...(options.id?.trim() ? { id: options.id.trim() } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
}

export function parseWorkflowUpdateInput(
  definitionId: string,
  options: {
    name?: string;
    description?: string;
    sourceFile?: string;
    source?: string;
  },
): UpdateWorkflowDefinitionInput {
  const id = definitionId.trim();
  if (!id) {
    throw {
      code: "INVALID_DEFINITION_ID",
      message: "definitionId cannot be empty",
    } satisfies CommandError;
  }
  const update: UpdateWorkflowDefinitionInput = { id };
  if (options.name !== undefined) {
    const name = options.name.trim();
    if (!name) {
      throw {
        code: "INVALID_NAME",
        message: "--name cannot be empty",
      } satisfies CommandError;
    }
    update.name = name;
  }
  if (options.description !== undefined) {
    update.description = options.description.trim() ? options.description.trim() : null;
  }
  if (options.sourceFile !== undefined) {
    update.source = readSourceFile(options.sourceFile);
  } else if (options.source !== undefined) {
    const source = options.source.trim();
    if (!source) {
      throw {
        code: "INVALID_SOURCE",
        message: "--source cannot be empty",
      } satisfies CommandError;
    }
    update.source = source;
  }
  if (
    update.name === undefined &&
    update.description === undefined &&
    update.source === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "provide at least one of --name, --description, --source-file, or --source",
    } satisfies CommandError;
  }
  return update;
}

export function parseWorkflowDispatchInput(
  definitionId: string,
  options: {
    arg?: string[];
    provider?: string;
    model?: string;
    thinking?: string;
    mode?: string;
    fast?: boolean;
    cwd?: string;
    repoPath?: string;
  },
): DispatchWorkflowRunInput {
  const id = definitionId.trim();
  if (!id) {
    throw {
      code: "INVALID_DEFINITION_ID",
      message: "definitionId cannot be empty",
    } satisfies CommandError;
  }
  const args = parseArgFlags(options.arg ?? []);
  const provider = options.provider?.trim();
  if (provider) {
    args.provider = provider;
  }
  const model = options.model?.trim();
  if (model) {
    args.model = model;
  }
  const thinking = options.thinking?.trim();
  if (thinking) {
    args.effort = thinking;
  }
  const mode = options.mode?.trim();
  if (mode) {
    args.mode = mode;
  }
  if (options.fast === true) {
    args.fast = true;
  }
  return {
    definitionId: id,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(options.cwd?.trim() ? { cwd: options.cwd.trim() } : {}),
    ...(options.repoPath?.trim() ? { repoPath: options.repoPath.trim() } : {}),
  };
}

export function parseArgFlags(flags: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0) {
      throw {
        code: "INVALID_ARG",
        message: `--arg must be key=value (got "${flag}")`,
      } satisfies CommandError;
    }
    const key = flag.slice(0, eq).trim();
    const raw = flag.slice(eq + 1);
    if (!key) {
      throw {
        code: "INVALID_ARG",
        message: `--arg key cannot be empty (got "${flag}")`,
      } satisfies CommandError;
    }
    args[key] = parseArgValue(raw);
  }
  return args;
}

function parseArgValue(raw: string): unknown {
  if (raw === "") {
    return "";
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function toWorkflowDefinitionRow(definition: WorkflowDefinition): WorkflowDefinitionRow {
  return {
    id: definition.id,
    name: definition.name,
    builtin: definition.builtin ? "yes" : "no",
    updatedAt: definition.updatedAt,
    description: definition.description ?? "",
  };
}

export function toWorkflowRunRow(run: WorkflowRun): WorkflowRunRow {
  return {
    id: run.id,
    definitionId: run.definitionId,
    status: run.status,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt ?? "",
    endedAt: run.endedAt ?? "",
    cwd: run.cwd,
  };
}

export function requireWorkflowValue<T>(
  payload: { value: T; error: string | null },
  fallbackMessage: string,
): NonNullable<T> {
  if (payload.error || payload.value == null) {
    throw new Error(payload.error ?? fallbackMessage);
  }
  return payload.value as NonNullable<T>;
}
