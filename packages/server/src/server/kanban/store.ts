import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  StoredKanbanCardSchema,
  StoredKanbanSourceSchema,
  type CreateKanbanCardInput,
  type CreateKanbanSourceInput,
  type KanbanCardSource,
  type KanbanPriority,
  type KanbanStatus,
  type MoveKanbanCardInput,
  type StoredKanbanCard,
  type StoredKanbanSource,
  type UpdateKanbanCardInput,
  type UpdateKanbanSourceInput,
} from "@getpaseo/protocol/kanban/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateCardId(): string {
  return `kbc_${randomBytes(4).toString("hex")}`;
}

function generateSourceId(): string {
  return `kbs_${randomBytes(4).toString("hex")}`;
}

// Externally-sourced card, keyed on (source.kind, externalId) for idempotent upsert.
type ExternalKanbanCardSource = Extract<KanbanCardSource, { externalId: string }>;

export interface UpsertKanbanCardBySourcePayload {
  title: string;
  url: string | null;
  status: KanbanStatus;
  theme: string;
  labels?: string[];
  assignee?: string | null;
  priority?: KanbanPriority | null;
  metadata?: Record<string, unknown>;
}

export class KanbanStore {
  private readonly cardMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private readonly sourcesMutations = new Map<string, Promise<unknown>>();
  private static readonly SOURCES_LOCK = "sources";

  constructor(private readonly dir: string) {}

  private get cardsDir(): string {
    return join(this.dir, "cards");
  }

  private get sourcesFile(): string {
    return join(this.dir, "sources.json");
  }

  private cardFilePath(id: string): string {
    return join(this.cardsDir, `${id}.json`);
  }

  private async ensureCardsDir(): Promise<void> {
    await mkdir(this.cardsDir, { recursive: true });
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  async listCards(): Promise<StoredKanbanCard[]> {
    await this.ensureCardsDir();
    const entries = await readdir(this.cardsDir, { withFileTypes: true });
    const cards = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.cardsDir, entry.name), "utf-8");
          return StoredKanbanCardSchema.parse(JSON.parse(content));
        }),
    );
    return cards.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getCard(id: string): Promise<StoredKanbanCard | null> {
    await this.ensureCardsDir();
    try {
      const content = await readFile(this.cardFilePath(id), "utf-8");
      return StoredKanbanCardSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async createCard(input: CreateKanbanCardInput): Promise<StoredKanbanCard> {
    const status = input.status ?? "pending";
    const source: KanbanCardSource = input.source ?? { kind: "manual" };
    // Serialize creates per target column so concurrent adds read a consistent
    // card list and never compute a duplicate `order` for the same status.
    return this.serializeIdentityMutation(`create:${status}`, async () => {
      const now = new Date().toISOString();
      const cards = await this.listCards();
      const card = StoredKanbanCardSchema.parse({
        id: generateCardId(),
        title: input.title,
        url: input.url ?? null,
        status,
        theme: input.theme ?? this.defaultThemeForSource(source),
        source,
        externalId: input.externalId ?? null,
        order: this.nextOrderForStatus(cards, status),
        statusPinnedByUser: false,
        labels: input.labels,
        assignee: input.assignee ?? null,
        priority: input.priority ?? null,
        trigger: input.trigger,
        metadata: input.metadata,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeCard(card);
      return card;
    });
  }

  async updateCard(input: UpdateKanbanCardInput): Promise<StoredKanbanCard | null> {
    return this.serializeCardMutation(input.id, async () => {
      const current = await this.getCard(input.id);
      if (!current) {
        return null;
      }
      const next = StoredKanbanCardSchema.parse({
        ...current,
        title: input.title ?? current.title,
        url: input.url === undefined ? current.url : input.url,
        status: input.status ?? current.status,
        theme: input.theme ?? current.theme,
        order: input.order ?? current.order,
        labels: input.labels ?? current.labels,
        assignee: input.assignee === undefined ? current.assignee : input.assignee,
        priority: input.priority === undefined ? current.priority : input.priority,
        trigger: input.trigger === null ? undefined : (input.trigger ?? current.trigger),
        metadata: input.metadata ?? current.metadata,
        // An explicit status change here is a deliberate user action, so pin it
        // the same way a drag does — otherwise the next source sync reverts it.
        statusPinnedByUser:
          input.status !== undefined && input.status !== current.status
            ? true
            : current.statusPinnedByUser,
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(next);
      return next;
    });
  }

  // Drag-to-column move. Always pins statusPinnedByUser so source sync stops
  // overwriting status for this card.
  async moveCard(input: MoveKanbanCardInput): Promise<StoredKanbanCard | null> {
    return this.serializeCardMutation(input.id, async () => {
      const current = await this.getCard(input.id);
      if (!current) {
        return null;
      }
      const cards = await this.listCards();
      const order =
        input.order ??
        this.nextOrderForStatus(
          cards.filter((card) => card.id !== current.id),
          input.status,
        );
      const next = StoredKanbanCardSchema.parse({
        ...current,
        status: input.status,
        order,
        statusPinnedByUser: true,
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(next);
      return next;
    });
  }

  async deleteCard(id: string): Promise<boolean> {
    return this.serializeCardMutation(id, async () => {
      const existing = await this.getCard(id);
      if (!existing) {
        return false;
      }
      await this.ensureCardsDir();
      await rm(this.cardFilePath(id), { force: true });
      return true;
    });
  }

  // Idempotent upsert keyed on (source.kind, externalId): existing card is
  // updated, missing card is created. Never duplicates for the same identity.
  async upsertCardBySource(
    source: ExternalKanbanCardSource,
    payload: UpsertKanbanCardBySourcePayload,
  ): Promise<StoredKanbanCard> {
    const identity = `${source.kind}:${source.externalId}`;
    return this.serializeIdentityMutation(identity, async () => {
      const cards = await this.listCards();
      const existing = cards.find(
        (card) => card.source.kind === source.kind && card.externalId === source.externalId,
      );
      const now = new Date().toISOString();
      if (!existing) {
        const created = StoredKanbanCardSchema.parse({
          id: generateCardId(),
          title: payload.title,
          url: payload.url,
          status: payload.status,
          theme: payload.theme,
          source,
          externalId: source.externalId,
          order: this.nextOrderForStatus(cards, payload.status),
          statusPinnedByUser: false,
          labels: payload.labels,
          assignee: payload.assignee ?? null,
          priority: payload.priority ?? null,
          metadata: payload.metadata,
          createdAt: now,
          updatedAt: now,
        });
        await this.writeCard(created);
        return created;
      }

      const updated = StoredKanbanCardSchema.parse({
        ...existing,
        title: payload.title,
        url: payload.url,
        theme: payload.theme,
        source,
        // Once the user drags the card, sync stops overwriting status.
        status: existing.statusPinnedByUser ? existing.status : payload.status,
        labels: payload.labels ?? existing.labels,
        // The source is authoritative for synced fields: when it reports the
        // ticket as unassigned (payload.assignee === null) clear the card too,
        // rather than keeping a stale assignee. Only a truly omitted (undefined)
        // field falls back to the existing value.
        assignee: payload.assignee === undefined ? existing.assignee : payload.assignee,
        priority: payload.priority === undefined ? existing.priority : payload.priority,
        metadata: payload.metadata ?? existing.metadata,
        updatedAt: now,
      });
      await this.writeCard(updated);
      return updated;
    });
  }

  private defaultThemeForSource(source: KanbanCardSource): string {
    if (source.kind === "jira") return "jira";
    if (source.kind === "gitlab") return "gitlab-mr";
    return "manual";
  }

  private nextOrderForStatus(cards: StoredKanbanCard[], status: KanbanStatus): number {
    const inStatus = cards.filter((card) => card.status === status);
    if (inStatus.length === 0) {
      return 0;
    }
    return Math.max(...inStatus.map((card) => card.order)) + 1;
  }

  private async writeCard(card: StoredKanbanCard): Promise<void> {
    await this.ensureCardsDir();
    await writeJsonFileAtomic(this.cardFilePath(card.id), card);
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async listSources(): Promise<StoredKanbanSource[]> {
    await this.ensureDir();
    try {
      const content = await readFile(this.sourcesFile, "utf-8");
      const parsed = JSON.parse(content) as unknown[];
      return parsed
        .map((entry) => StoredKanbanSourceSchema.parse(entry))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async getSource(id: string): Promise<StoredKanbanSource | null> {
    const sources = await this.listSources();
    return sources.find((source) => source.id === id) ?? null;
  }

  async createSource(input: CreateKanbanSourceInput): Promise<StoredKanbanSource> {
    return this.serializeSourcesMutation(async () => {
      const sources = await this.listSources();
      const now = new Date().toISOString();
      const created = StoredKanbanSourceSchema.parse({
        id: generateSourceId(),
        kind: input.kind,
        name: input.name,
        enabled: input.enabled ?? true,
        baseUrl: input.baseUrl,
        query: input.query,
        statusMap: input.statusMap,
        pollEverySec: input.pollEverySec ?? 300,
        auth: input.auth,
        lastSyncAt: null,
        lastSyncError: null,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeSources([...sources, created]);
      return created;
    });
  }

  async updateSource(input: UpdateKanbanSourceInput): Promise<StoredKanbanSource | null> {
    return this.serializeSourcesMutation(async () => {
      const sources = await this.listSources();
      const index = sources.findIndex((source) => source.id === input.id);
      if (index === -1) {
        return null;
      }
      const current = sources[index];
      const updated = StoredKanbanSourceSchema.parse({
        ...current,
        name: input.name ?? current.name,
        baseUrl: input.baseUrl ?? current.baseUrl,
        query: input.query ?? current.query,
        enabled: input.enabled ?? current.enabled,
        statusMap: input.statusMap === null ? undefined : (input.statusMap ?? current.statusMap),
        pollEverySec: input.pollEverySec ?? current.pollEverySec,
        auth: input.auth === null ? undefined : (input.auth ?? current.auth),
        updatedAt: new Date().toISOString(),
      });
      const next = [...sources];
      next[index] = updated;
      await this.writeSources(next);
      return updated;
    });
  }

  // Records the outcome of a sync run. Not part of the update RPC contract —
  // called directly by the sync service.
  async recordSourceSync(
    id: string,
    result: { lastSyncAt: string; lastSyncError: string | null },
  ): Promise<StoredKanbanSource | null> {
    return this.serializeSourcesMutation(async () => {
      const sources = await this.listSources();
      const index = sources.findIndex((source) => source.id === id);
      if (index === -1) {
        return null;
      }
      const updated = StoredKanbanSourceSchema.parse({
        ...sources[index],
        lastSyncAt: result.lastSyncAt,
        lastSyncError: result.lastSyncError,
        updatedAt: new Date().toISOString(),
      });
      const next = [...sources];
      next[index] = updated;
      await this.writeSources(next);
      return updated;
    });
  }

  async deleteSource(id: string): Promise<boolean> {
    return this.serializeSourcesMutation(async () => {
      const sources = await this.listSources();
      const next = sources.filter((source) => source.id !== id);
      if (next.length === sources.length) {
        return false;
      }
      await this.writeSources(next);
      return true;
    });
  }

  private async writeSources(sources: StoredKanbanSource[]): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.sourcesFile, sources);
  }

  // -------------------------------------------------------------------------
  // Mutation serialization
  // -------------------------------------------------------------------------

  private async serializeCardMutation<T>(cardId: string, mutation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.cardMutations, cardId, mutation);
  }

  private async serializeIdentityMutation<T>(
    identity: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeMutation(this.identityMutations, identity, mutation);
  }

  private async serializeSourcesMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.sourcesMutations, KanbanStore.SOURCES_LOCK, mutation);
  }

  private async serializeMutation<T>(
    promises: Map<string, Promise<unknown>>,
    key: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = promises.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    promises.set(key, next);
    try {
      return await next;
    } finally {
      if (promises.get(key) === next) {
        promises.delete(key);
      }
    }
  }
}
