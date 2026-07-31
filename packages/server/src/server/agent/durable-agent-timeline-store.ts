import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

interface DurableTimelineFile {
  epoch: string;
  nextSeq: number;
  rows: AgentTimelineRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDurableTimelineFile(raw: string): DurableTimelineFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const epoch = typeof parsed.epoch === "string" ? parsed.epoch : null;
  const nextSeq =
    typeof parsed.nextSeq === "number" && Number.isFinite(parsed.nextSeq)
      ? Math.max(1, Math.floor(parsed.nextSeq))
      : null;
  if (!epoch || nextSeq == null || !Array.isArray(parsed.rows)) {
    return null;
  }
  const rows: AgentTimelineRow[] = [];
  for (const entry of parsed.rows) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.seq !== "number" || typeof entry.timestamp !== "string") {
      continue;
    }
    if (!isRecord(entry.item) || typeof entry.item.type !== "string") {
      continue;
    }
    rows.push({
      seq: entry.seq,
      timestamp: entry.timestamp,
      item: entry.item as AgentTimelineItem,
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  return { epoch, nextSeq, rows };
}

/**
 * File-backed {@link AgentTimelineStore} under `$PASEO_HOME/agent-timelines/{agentId}.json`.
 * Keeps an in-memory mirror so restart can reseeds AgentManager without replaying provider history.
 */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly memory = new InMemoryAgentTimelineStore();
  private readonly loaded = new Set<string>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      this.memory.initialize(agentId, { timestamp: options?.timestamp });
    }
    const row = this.memory.append(agentId, item, options);
    await this.persist(agentId);
    return row;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      const epoch = randomUUID();
      return {
        epoch,
        direction: options?.direction ?? "tail",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }
    return this.memory.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      return 0;
    }
    const rows = this.memory.getRows(agentId);
    return rows.length > 0 ? rows[rows.length - 1].seq : 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      return [];
    }
    return this.memory.getRows(agentId);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      return null;
    }
    return this.memory.getLastItem(agentId);
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    await this.ensureLoaded(agentId);
    if (!this.memory.has(agentId)) {
      return null;
    }
    return this.memory.getLastAssistantMessage(agentId);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.enqueueWrite(agentId, async () => {
      this.memory.delete(agentId);
      this.loaded.add(agentId);
      await rm(this.filePath(agentId), { force: true });
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.ensureLoaded(agentId);
    const existing = this.memory.has(agentId) ? this.memory.getRows(agentId) : [];
    const bySeq = new Map<number, AgentTimelineRow>();
    for (const row of existing) {
      bySeq.set(row.seq, row);
    }
    for (const row of rows) {
      bySeq.set(row.seq, { ...row });
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    const nextSeq = merged.length > 0 ? merged[merged.length - 1].seq + 1 : 1;
    const epoch = this.memory.has(agentId) ? this.memory.getEpoch(agentId) : randomUUID();
    this.memory.initialize(agentId, { epoch, nextSeq, rows: merged });
    await this.persist(agentId);
  }

  private filePath(agentId: string): string {
    return join(this.rootDir, `${agentId}.json`);
  }

  private async ensureLoaded(agentId: string): Promise<void> {
    if (this.loaded.has(agentId)) {
      return;
    }
    await this.enqueueWrite(agentId, async () => {
      if (this.loaded.has(agentId)) {
        return;
      }
      await mkdir(this.rootDir, { recursive: true });
      let raw: string;
      try {
        raw = await readFile(this.filePath(agentId), "utf8");
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        if (code !== "ENOENT") {
          throw error;
        }
        this.loaded.add(agentId);
        return;
      }
      const parsed = parseDurableTimelineFile(raw);
      if (parsed) {
        this.memory.initialize(agentId, {
          epoch: parsed.epoch,
          nextSeq: parsed.nextSeq,
          rows: parsed.rows,
        });
      }
      this.loaded.add(agentId);
    });
  }

  private async persist(agentId: string): Promise<void> {
    await this.enqueueWrite(agentId, async () => {
      if (!this.memory.has(agentId)) {
        return;
      }
      const fetched = this.memory.fetch(agentId, { direction: "tail", limit: 0 });
      const payload: DurableTimelineFile = {
        epoch: fetched.epoch,
        nextSeq: fetched.window.nextSeq,
        rows: fetched.rows,
      };
      await writeJsonFileAtomic(this.filePath(agentId), payload);
      this.loaded.add(agentId);
    });
  }

  private enqueueWrite(agentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.writeChains.set(
      agentId,
      next.catch(() => undefined),
    );
    return next;
  }
}
