export interface WorkflowQueueOptions {
  maxConcurrency?: number;
}

export class WorkflowQueue {
  private readonly maxConcurrency: number;
  private readonly pending: Array<() => void> = [];
  private active = 0;

  constructor(options: WorkflowQueueOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  async enqueue<T>(run: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
      this.drain();
    });
    try {
      return await run();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        return;
      }
      this.active += 1;
      next();
    }
  }
}
