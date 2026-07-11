import {
  KanbanPrioritySchema,
  KanbanSourceKindSchema,
  KanbanStatusSchema,
} from "@getpaseo/protocol/kanban/types";
import type {
  CreateKanbanCardInput,
  CreateKanbanSourceInput,
  KanbanPriority,
  KanbanSourceKind,
  KanbanStatus,
  MoveKanbanCardInput,
  UpdateKanbanCardInput,
} from "@getpaseo/protocol/kanban/types";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type { KanbanDaemonClient, StoredKanbanCard, StoredKanbanSource } from "./types.js";

export interface KanbanCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectKanbanClient(
  host: string | undefined,
): Promise<{ client: KanbanDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = (await connectToDaemon({ host })) as unknown as KanbanDaemonClient;
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

export function toKanbanCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

const THEME_PATTERN = /^#[0-9a-fA-F]{6}$/;
const KNOWN_THEMES = new Set(["jira", "gitlab-mr"]);

export function parseKanbanTheme(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || (!KNOWN_THEMES.has(trimmed) && !THEME_PATTERN.test(trimmed))) {
    throw {
      code: "INVALID_THEME",
      message: `--theme must be one of jira, gitlab-mr, or a #RRGGBB hex color (got "${value}")`,
    } satisfies CommandError;
  }
  return trimmed;
}

export function parseKanbanStatus(value: string | undefined): KanbanStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = KanbanStatusSchema.safeParse(value);
  if (!result.success) {
    throw {
      code: "INVALID_STATUS",
      message: `--status must be one of: ${KanbanStatusSchema.options.join(", ")} (got "${value}")`,
    } satisfies CommandError;
  }
  return result.data;
}

export function parseKanbanPriority(value: string | undefined): KanbanPriority | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = KanbanPrioritySchema.safeParse(value);
  if (!result.success) {
    throw {
      code: "INVALID_PRIORITY",
      message: `--priority must be one of: ${KanbanPrioritySchema.options.join(", ")} (got "${value}")`,
    } satisfies CommandError;
  }
  return result.data;
}

export function parseKanbanSourceKind(value: string): KanbanSourceKind {
  const result = KanbanSourceKindSchema.safeParse(value);
  if (!result.success) {
    throw {
      code: "INVALID_SOURCE_KIND",
      message: `--kind must be one of: ${KanbanSourceKindSchema.options.join(", ")} (got "${value}")`,
    } satisfies CommandError;
  }
  return result.data;
}

export function parseKanbanCardAddInput(options: {
  title?: string;
  url?: string;
  status?: string;
  theme?: string;
  label?: string[];
  priority?: string;
}): CreateKanbanCardInput {
  const title = options.title?.trim() ?? "";
  if (!title) {
    throw {
      code: "INVALID_TITLE",
      message: "--title cannot be empty",
    } satisfies CommandError;
  }
  const url = options.url?.trim();
  const theme = parseKanbanTheme(options.theme);
  const status = parseKanbanStatus(options.status);
  const priority = parseKanbanPriority(options.priority);
  const labels = options.label && options.label.length > 0 ? options.label : undefined;
  return {
    title,
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    ...(theme ? { theme } : {}),
    ...(labels ? { labels } : {}),
    ...(priority ? { priority } : {}),
  };
}

export function parseKanbanCardUpdateInput(
  id: string,
  options: {
    title?: string;
    url?: string;
    status?: string;
    theme?: string;
    label?: string[];
    priority?: string;
  },
): UpdateKanbanCardInput {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw {
      code: "INVALID_CARD_ID",
      message: "Card id cannot be empty",
    } satisfies CommandError;
  }
  const title = options.title !== undefined ? requireNonEmpty(options.title, "--title") : undefined;
  const url = options.url !== undefined ? options.url.trim() : undefined;
  const theme = parseKanbanTheme(options.theme);
  const status = parseKanbanStatus(options.status);
  const priority = parseKanbanPriority(options.priority);
  const labels = options.label && options.label.length > 0 ? options.label : undefined;

  if (
    title === undefined &&
    url === undefined &&
    status === undefined &&
    theme === undefined &&
    labels === undefined &&
    priority === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id: trimmedId,
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

export function parseKanbanCardMoveInput(
  id: string,
  options: { status?: string; order?: string },
): MoveKanbanCardInput {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw {
      code: "INVALID_CARD_ID",
      message: "Card id cannot be empty",
    } satisfies CommandError;
  }
  const status = parseKanbanStatus(options.status);
  if (!status) {
    throw {
      code: "MISSING_STATUS",
      message: "--status is required",
    } satisfies CommandError;
  }
  const order = options.order !== undefined ? Number.parseFloat(options.order) : undefined;
  if (order !== undefined && Number.isNaN(order)) {
    throw {
      code: "INVALID_ORDER",
      message: `--order must be a number (got "${options.order}")`,
    } satisfies CommandError;
  }
  return {
    id: trimmedId,
    status,
    ...(order !== undefined ? { order } : {}),
  };
}

export function parseKanbanSourceAddInput(options: {
  kind?: string;
  name?: string;
  baseUrl?: string;
  query?: string;
  pollEverySec?: string;
  tokenRef?: string;
}): CreateKanbanSourceInput {
  const kind = parseKanbanSourceKind(options.kind ?? "");
  const name = requireNonEmpty(options.name ?? "", "--name");
  const baseUrl = requireNonEmpty(options.baseUrl ?? "", "--base-url");
  const query = options.query ?? "";
  const pollEverySec =
    options.pollEverySec === undefined
      ? undefined
      : parsePositiveInt(options.pollEverySec, "--poll-every-sec");
  const tokenRef = options.tokenRef?.trim();
  return {
    kind,
    name,
    baseUrl,
    query,
    ...(pollEverySec !== undefined ? { pollEverySec } : {}),
    ...(tokenRef ? { auth: { method: "token" as const, credentialRef: tokenRef } } : {}),
  };
}

function requireNonEmpty(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `${flag} cannot be empty`,
    } satisfies CommandError;
  }
  return trimmed;
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

export interface KanbanCardRow {
  id: string;
  title: string;
  status: string;
  theme: string;
  url: string | null;
  labels: string;
  priority: string;
}

export function toKanbanCardRow(card: StoredKanbanCard): KanbanCardRow {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    theme: card.theme,
    url: card.url,
    labels: card.labels && card.labels.length > 0 ? card.labels.join(",") : "",
    priority: card.priority ?? "",
  };
}

export interface KanbanSourceRow {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export function toKanbanSourceRow(source: StoredKanbanSource): KanbanSourceRow {
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    baseUrl: source.baseUrl,
    enabled: source.enabled,
    lastSyncAt: source.lastSyncAt,
    lastSyncError: source.lastSyncError,
  };
}
