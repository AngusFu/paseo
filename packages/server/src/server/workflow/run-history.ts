/**
 * Reconstruct a compact event timeline for runs that never got an events.jsonl
 * (daemon predating the workflow event log, or logging failed).
 *
 * Sources: run record + engine journal.jsonl under the run workspace.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkflowLogEntrySchema,
  type WorkflowLogEntry,
  type WorkflowLogLevel,
  type WorkflowRun,
} from "@getpaseo/protocol/workflow/types";

const MESSAGE_MAX = 180;

export function paginateLogEntries(
  entries: WorkflowLogEntry[],
  options: { afterSeq?: number; limit?: number } = {},
): { entries: WorkflowLogEntry[]; nextSeq: number; hasMore: boolean } {
  const afterSeq = options.afterSeq ?? 0;
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const filtered = entries.filter((entry) => entry.seq > afterSeq);
  const page = filtered.slice(0, limit);
  return {
    entries: page,
    nextSeq: page.length > 0 ? page[page.length - 1]!.seq : afterSeq,
    hasMore: filtered.length > page.length,
  };
}

export async function reconstructRunHistory(run: WorkflowRun): Promise<WorkflowLogEntry[]> {
  const entries: WorkflowLogEntry[] = [];
  let seq = 0;

  const push = (input: {
    ts: string;
    level?: WorkflowLogLevel;
    event: string;
    message: string;
    data?: Record<string, unknown>;
  }) => {
    seq += 1;
    entries.push(
      WorkflowLogEntrySchema.parse({
        seq,
        ts: input.ts,
        level: input.level ?? "info",
        event: input.event,
        message: input.message,
        runId: run.id,
        definitionId: run.definitionId,
        ...(input.data && Object.keys(input.data).length > 0 ? { data: input.data } : {}),
      }),
    );
  };

  push({
    ts: run.queuedAt,
    event: "run.queued",
    message: "queued",
    data: {
      cwd: run.cwd,
      provider: readArgString(run.args, "provider"),
      model: readArgString(run.args, "model"),
    },
  });

  if (run.startedAt) {
    push({
      ts: run.startedAt,
      event: "run.start",
      message: "started",
      data: { workspaceId: run.workspaceId },
    });
  }

  if (run.workspaceId) {
    push({
      ts: run.startedAt ?? run.queuedAt,
      event: "run.workspace",
      message: `workspace ${run.workspaceId}`,
      data: { workspaceId: run.workspaceId, workspacePath: run.workspacePath },
    });
  }

  const journalPath = join(run.workspacePath, "journal.jsonl");
  try {
    const text = await readFile(journalPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { key?: unknown; result?: unknown };
        const key = typeof parsed.key === "string" ? parsed.key : "unknown";
        const summary = summarizeJournalResult(parsed.result);
        push({
          ts: run.startedAt ?? run.queuedAt,
          level: summary.level,
          event: "journal.record",
          message: `${key}  ${summary.message}`,
          data: { key },
        });
      } catch {
        // skip corrupt journal lines
      }
    }
  } catch {
    // no journal
  }

  const stats = readResultStats(run.result);
  if (stats) {
    push({
      ts: run.endedAt ?? run.startedAt ?? run.queuedAt,
      event: "run.stats",
      message: formatStats(stats),
      data: stats,
    });
  }

  if (run.endedAt) {
    if (run.status === "failed" || run.error) {
      push({
        ts: run.endedAt,
        level: "error",
        event: "run.failed",
        message: run.error ?? "failed",
      });
    } else if (run.status === "cancelled") {
      push({
        ts: run.endedAt,
        level: "warn",
        event: "run.cancelled",
        message: "cancelled",
      });
    } else {
      push({
        ts: run.endedAt,
        event: "run.succeeded",
        message: "succeeded",
      });
    }
  }

  return entries;
}

function readArgString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readResultStats(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const stats = (result as { stats?: unknown }).stats;
  if (!stats || typeof stats !== "object") return null;
  return stats as Record<string, unknown>;
}

function formatStats(stats: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof stats.agentCalls === "number") parts.push(`${stats.agentCalls} agent calls`);
  if (typeof stats.cacheHits === "number") parts.push(`${stats.cacheHits} cache hits`);
  if (typeof stats.structuredRetries === "number") {
    parts.push(`${stats.structuredRetries} retries`);
  }
  return parts.length > 0 ? parts.join(", ") : "stats recorded";
}

function summarizeJournalResult(result: unknown): { level: WorkflowLogLevel; message: string } {
  if (result == null) {
    return { level: "warn", message: "no result" };
  }
  if (typeof result !== "object") {
    return { level: "info", message: truncate(String(result)) };
  }
  const record = result as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return { level: "error", message: truncate(record.error) };
  }
  if (typeof record.verdict === "string") {
    const verdict = record.verdict.toUpperCase();
    let level: WorkflowLogLevel = "error";
    if (verdict === "PASS") {
      level = "info";
    } else if (verdict === "REVISE") {
      level = "warn";
    }
    const holes = Array.isArray(record.holes) ? record.holes.length : 0;
    return {
      level,
      message: holes > 0 ? `verdict=${record.verdict} holes=${holes}` : `verdict=${record.verdict}`,
    };
  }
  if (typeof record.summary === "string" && record.summary.trim()) {
    return { level: "info", message: truncate(record.summary) };
  }
  return { level: "info", message: "recorded" };
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MESSAGE_MAX) return normalized;
  return `${normalized.slice(0, MESSAGE_MAX - 1)}…`;
}
