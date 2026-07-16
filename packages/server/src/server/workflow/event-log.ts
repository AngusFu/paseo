/**
 * Append-only workflow event log.
 *
 * - Global: `$PASEO_HOME/workflows/events.jsonl` (all ops + run events)
 * - Per-run: `$PASEO_HOME/workflows/runs/{runId}/events.jsonl`
 *
 * Kept separate from daemon.log so workflow debugging doesn't require grepping
 * the whole daemon stream. Entries are compact one-line JSON.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WorkflowLogEntrySchema,
  type WorkflowLogEntry,
  type WorkflowLogLevel,
} from "@getpaseo/protocol/workflow/types";

export const WORKFLOW_LOG_PAGE_DEFAULT = 200;
export const WORKFLOW_LOG_PAGE_MAX = 500;

export interface WorkflowEventLogWriteInput {
  level?: WorkflowLogLevel;
  event: string;
  message: string;
  runId?: string;
  definitionId?: string;
  data?: Record<string, unknown>;
}

export interface WorkflowEventLogReadOptions {
  afterSeq?: number;
  limit?: number;
}

export interface WorkflowEventLogPage {
  entries: WorkflowLogEntry[];
  nextSeq: number;
  hasMore: boolean;
}

export class WorkflowEventLog {
  private seq = 0;
  private seqLoaded = false;

  constructor(private readonly workflowsDir: string) {}

  private get globalPath(): string {
    return join(this.workflowsDir, "events.jsonl");
  }

  private runPath(runId: string): string {
    return join(this.workflowsDir, "runs", runId, "events.jsonl");
  }

  private async ensureSeq(): Promise<void> {
    if (this.seqLoaded) {
      return;
    }
    try {
      const text = await readFile(this.globalPath, "utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
            this.seq = parsed.seq;
            break;
          }
        } catch {
          // skip corrupt trailing lines
        }
      }
    } catch {
      // missing file → start at 0
    }
    this.seqLoaded = true;
  }

  async append(input: WorkflowEventLogWriteInput): Promise<WorkflowLogEntry> {
    await this.ensureSeq();
    this.seq += 1;
    const entry = WorkflowLogEntrySchema.parse({
      seq: this.seq,
      ts: new Date().toISOString(),
      level: input.level ?? "info",
      event: input.event,
      message: input.message,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.definitionId ? { definitionId: input.definitionId } : {}),
      ...(input.data && Object.keys(input.data).length > 0 ? { data: input.data } : {}),
    });
    const line = `${JSON.stringify(entry)}\n`;
    await mkdir(dirname(this.globalPath), { recursive: true });
    await appendFile(this.globalPath, line, "utf8");
    if (input.runId) {
      const path = this.runPath(input.runId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    }
    return entry;
  }

  /** True when a per-run events.jsonl exists and has at least one parseable line. */
  async hasRunLogs(runId: string): Promise<boolean> {
    const path = this.runPath(runId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return false;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        WorkflowLogEntrySchema.parse(JSON.parse(trimmed));
        return true;
      } catch {
        // keep scanning
      }
    }
    return false;
  }

  async readRunLogs(
    runId: string,
    options: WorkflowEventLogReadOptions = {},
  ): Promise<WorkflowEventLogPage> {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(
      Math.max(options.limit ?? WORKFLOW_LOG_PAGE_DEFAULT, 1),
      WORKFLOW_LOG_PAGE_MAX,
    );
    const path = this.runPath(runId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { entries: [], nextSeq: afterSeq, hasMore: false };
    }
    const entries: WorkflowLogEntry[] = [];
    let hasMore = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = WorkflowLogEntrySchema.parse(JSON.parse(trimmed));
        if (parsed.seq <= afterSeq) continue;
        if (entries.length >= limit) {
          hasMore = true;
          break;
        }
        entries.push(parsed);
      } catch {
        // skip corrupt lines
      }
    }
    const nextSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : afterSeq;
    return { entries, nextSeq, hasMore };
  }
}
