/**
 * Append-only workflow event log.
 *
 * - Global: `$PASEO_HOME/workflows/events.jsonl` (all ops + run events)
 * - Per-run: `$PASEO_HOME/workflows/runs/{runId}/events.jsonl`
 *
 * Kept separate from daemon.log so workflow debugging doesn't require grepping
 * the whole daemon stream. Entries are compact one-line JSON.
 */
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WorkflowLogEntrySchema,
  type WorkflowLogEntry,
  type WorkflowLogLevel,
} from "@getpaseo/protocol/workflow/types";

export const WORKFLOW_LOG_PAGE_DEFAULT = 200;
export const WORKFLOW_LOG_PAGE_MAX = 500;

/** Sort in place by seq, but only when an out-of-order pair actually exists. */
function ensureSortedBySeq(entries: WorkflowLogEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.seq < entries[i - 1]!.seq) {
      entries.sort((left, right) => left.seq - right.seq);
      return;
    }
  }
}

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

/**
 * Per-run incremental read cache. `offset` is the total byte count already
 * read from disk (including any trailing partial line kept in `leftover`),
 * so the next read only fetches bytes appended since the last call.
 */
interface RunLogCache {
  size: number;
  mtimeMs: number;
  entries: WorkflowLogEntry[];
  offset: number;
  leftover: Buffer;
}

/** Upper bound on concurrently cached runs (LRU eviction — see touchRunCache). */
const MAX_RUN_LOG_CACHES = 16;

export class WorkflowEventLog {
  private seq = 0;
  private seqLoaded = false;
  private readonly runCaches = new Map<string, RunLogCache>();

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

  private static parseLine(line: string): WorkflowLogEntry | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return WorkflowLogEntrySchema.parse(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  private static appendParsedLine(entries: WorkflowLogEntry[], line: string): void {
    const parsed = WorkflowEventLog.parseLine(line);
    if (parsed) {
      entries.push(parsed);
    }
  }

  /**
   * Load (or incrementally refresh) the parsed-entries cache for a run.
   * Returns `null` when the run has no events.jsonl on disk.
   *
   * Only the bytes appended since the last call are read + parsed; a file
   * that shrank (truncated/rebuilt) resets the cache and re-reads in full.
   */
  private async loadRunCache(runId: string): Promise<RunLogCache | null> {
    const path = this.runPath(runId);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(path);
    } catch {
      this.runCaches.delete(runId);
      return null;
    }

    let cache = this.runCaches.get(runId);
    if (cache && stats.size < cache.size) {
      // File shrank — truncated/rebuilt underneath us. Reset and re-read fully.
      cache = undefined;
    }
    if (!cache) {
      cache = { size: 0, mtimeMs: 0, entries: [], offset: 0, leftover: Buffer.alloc(0) };
    }

    if (stats.size === cache.size && stats.mtimeMs === cache.mtimeMs) {
      this.touchRunCache(runId, cache);
      return cache;
    }

    const toRead = stats.size - cache.offset;
    if (toRead > 0) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(toRead);
        await fh.read(buf, 0, toRead, cache.offset);
        const combined = cache.leftover.length > 0 ? Buffer.concat([cache.leftover, buf]) : buf;
        const text = combined.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        const consumedText = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
        const leftoverText = lastNewline === -1 ? text : text.slice(lastNewline + 1);
        if (consumedText) {
          for (const line of consumedText.split("\n")) {
            WorkflowEventLog.appendParsedLine(cache.entries, line);
          }
          // Concurrent `void log(...)` appends can land in the file out of
          // seq order. Pagination is seq-based (`afterSeq` cursor), so an
          // out-of-order line behind a higher-seq page boundary would be
          // skipped forever — keep the cache seq-sorted.
          ensureSortedBySeq(cache.entries);
        }
        // All bytes up to `stats.size` are now accounted for (either parsed
        // into `entries` or held as the new trailing partial line) — advance
        // by the full read length, not just the consumed-line byte count, so
        // the next read starts past bytes already captured in `leftover`.
        cache.offset = stats.size;
        cache.leftover = Buffer.from(leftoverText, "utf8");
      } finally {
        await fh.close();
      }
    }
    cache.size = stats.size;
    cache.mtimeMs = stats.mtimeMs;
    this.touchRunCache(runId, cache);
    return cache;
  }

  /**
   * (Re)insert a run's cache as most-recently-used and evict the oldest
   * entries beyond MAX_RUN_LOG_CACHES — a long-lived daemon must not keep
   * every historical run's parsed log in memory forever.
   */
  private touchRunCache(runId: string, cache: RunLogCache): void {
    this.runCaches.delete(runId);
    this.runCaches.set(runId, cache);
    while (this.runCaches.size > MAX_RUN_LOG_CACHES) {
      const oldest = this.runCaches.keys().next().value;
      if (oldest === undefined) break;
      this.runCaches.delete(oldest);
    }
  }

  /** True when a per-run events.jsonl exists and has at least one parseable line. */
  async hasRunLogs(runId: string): Promise<boolean> {
    const cache = await this.loadRunCache(runId);
    return (cache?.entries.length ?? 0) > 0;
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
    const cache = await this.loadRunCache(runId);
    if (!cache) {
      return { entries: [], nextSeq: afterSeq, hasMore: false };
    }
    const entries: WorkflowLogEntry[] = [];
    let hasMore = false;
    for (const parsed of cache.entries) {
      if (parsed.seq <= afterSeq) continue;
      if (entries.length >= limit) {
        hasMore = true;
        break;
      }
      entries.push(parsed);
    }
    const nextSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : afterSeq;
    return { entries, nextSeq, hasMore };
  }
}
