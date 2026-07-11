import type pino from "pino";
import type { KanbanStore } from "./store.js";
import type { KanbanSyncService } from "./sync.js";

const POLL_TICK_INTERVAL_MS = 5_000;

export interface KanbanPollServiceOptions {
  store: KanbanStore;
  syncService: KanbanSyncService;
  logger?: pino.Logger;
  tickIntervalMs?: number;
  now?: () => Date;
}

// Sweeps all enabled sources on a single timer (mirrors ScheduleService's
// tick-loop in schedule/service.ts) rather than one setInterval per source —
// simpler lifecycle, no per-source timer leak to track on delete/disable.
export class KanbanPollService {
  private readonly store: KanbanStore;
  private readonly syncService: KanbanSyncService;
  private readonly logger?: pino.Logger;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly syncingSourceIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KanbanPollServiceOptions) {
    this.store = options.store;
    this.syncService = options.syncService;
    this.logger = options.logger;
    this.tickIntervalMs = options.tickIntervalMs ?? POLL_TICK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger?.error({ err: error }, "Failed to process kanban poll tick");
      });
    }, this.tickIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // Exposed directly so tests can drive one sweep deterministically instead
  // of racing a real setInterval.
  async tick(): Promise<void> {
    const sources = await this.store.listSources();
    const nowMs = this.now().getTime();
    for (const source of sources) {
      if (!source.enabled || this.syncingSourceIds.has(source.id)) {
        continue;
      }
      const lastSyncMs = source.lastSyncAt ? new Date(source.lastSyncAt).getTime() : null;
      const dueInMs = source.pollEverySec * 1000;
      if (lastSyncMs !== null && nowMs - lastSyncMs < dueInMs) {
        continue;
      }
      this.syncingSourceIds.add(source.id);
      try {
        await this.syncService.sync(source);
      } catch (error) {
        this.logger?.warn({ err: error, sourceId: source.id }, "Kanban poll sync failed");
      } finally {
        this.syncingSourceIds.delete(source.id);
      }
    }
  }
}
