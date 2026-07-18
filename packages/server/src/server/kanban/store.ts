import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  KanbanColumnSchema,
  StoredKanbanCardSchema,
  StoredKanbanConnectionSchema,
  StoredKanbanSourceSchema,
  type CreateKanbanCardInput,
  type CreateKanbanColumnInput,
  type CreateKanbanConnectionInput,
  type CreateKanbanSourceInput,
  type DeleteKanbanColumnInput,
  type KanbanCardSource,
  type KanbanColumn,
  type KanbanPriority,
  type KanbanStatus,
  type MoveKanbanCardInput,
  type ReorderKanbanColumnInput,
  type StoredKanbanCard,
  type StoredKanbanConnection,
  type StoredKanbanSource,
  type UpdateKanbanCardInput,
  type UpdateKanbanColumnInput,
  type UpdateKanbanConnectionInput,
  type UpdateKanbanSourceInput,
} from "@getpaseo/protocol/kanban/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateCardId(): string {
  return `kbc_${randomBytes(4).toString("hex")}`;
}

function generateSourceId(): string {
  return `kbs_${randomBytes(4).toString("hex")}`;
}

function generateConnectionId(): string {
  return `kbn_${randomBytes(4).toString("hex")}`;
}

function generateColumnId(): string {
  return `kbcol_${randomBytes(4).toString("hex")}`;
}

// Lazily-created default columns: three status-category buckets (Jira-style
// To Do / In Progress / Done) rather than one column per legacy status — a
// real Jira project can have a dozen-plus statuses, and mirroring the
// category rather than every status name keeps the default board usable.
const DEFAULT_COLUMNS: ReadonlyArray<{ title: string; legacyStatus: KanbanStatus }> = [
  { title: "To Do", legacyStatus: "pending" },
  { title: "In Progress", legacyStatus: "wip" },
  { title: "Done", legacyStatus: "done" },
];

// Buckets a legacy status down to the status-category column it belongs to
// when no column has that exact legacyStatus (the common case once the
// board only has the three default columns): skip/fail/abort are terminal
// outcomes, same as done.
function bucketLegacyStatus(status: KanbanStatus): KanbanStatus {
  if (status === "pending" || status === "wip") {
    return status;
  }
  return "done";
}

// Externally-sourced card, keyed on (source.kind, externalId) for idempotent upsert.
type ExternalKanbanCardSource = Extract<KanbanCardSource, { externalId: string }>;

export interface UpsertKanbanCardBySourcePayload {
  title: string;
  url: string | null;
  status: KanbanStatus;
  columnId: string;
  theme: string;
  // The StoredKanbanSource.id running this sync. Optional so old callers
  // (tests, scripts) keep compiling; sync.ts always passes it.
  sourceId?: string;
  labels?: string[];
  assignee?: string | null;
  priority?: KanbanPriority | null;
  metadata?: Record<string, unknown>;
  // Tracker's own timestamps (ISO), separate from the Paseo-local ones.
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  // GitLab MR: unresolved blocking discussion threads present.
  hasUnresolvedThreads?: boolean;
  // When true, this sync applies status/columnId even to a user-pinned card.
  // Used for terminal transitions (MR merged/closed) that should win over a
  // manual drag — a merged MR belongs in done regardless.
  forceStatus?: boolean;
}

export interface UpsertKanbanCardBySourceResult extends StoredKanbanCard {
  created: boolean;
}

export class KanbanStore {
  private readonly cardMutations = new Map<string, Promise<unknown>>();
  private readonly identityMutations = new Map<string, Promise<unknown>>();
  private readonly sourcesMutations = new Map<string, Promise<unknown>>();
  private readonly connectionsMutations = new Map<string, Promise<unknown>>();
  private readonly columnsMutations = new Map<string, Promise<unknown>>();
  private static readonly SOURCES_LOCK = "sources";
  private static readonly CONNECTIONS_LOCK = "connections";
  private static readonly COLUMNS_LOCK = "columns";
  // In-memory mirror of the cards directory, keyed by card id. This process is
  // the sole writer of these files (CLI/clients go through RPC to this
  // daemon), so the cache and disk never diverge outside of this class.
  // Populated lazily on first read, kept in sync by every write path.
  private cardsCache: Map<string, StoredKanbanCard> | null = null;
  private cardsCacheLoading: Promise<Map<string, StoredKanbanCard>> | null = null;

  constructor(private readonly dir: string) {}

  private get cardsDir(): string {
    return join(this.dir, "cards");
  }

  private get sourcesFile(): string {
    return join(this.dir, "sources.json");
  }

  private get connectionsFile(): string {
    return join(this.dir, "connections.json");
  }

  private get columnsFile(): string {
    return join(this.dir, "columns.json");
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
    const cache = await this.loadCardsCache();
    return [...cache.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getCard(id: string): Promise<StoredKanbanCard | null> {
    const cache = await this.loadCardsCache();
    return cache.get(id) ?? null;
  }

  // Loads the cards directory into cardsCache on first call; every later
  // call (including concurrent ones mid-load) reuses the same cache/promise.
  private async loadCardsCache(): Promise<Map<string, StoredKanbanCard>> {
    if (this.cardsCache) {
      return this.cardsCache;
    }
    if (!this.cardsCacheLoading) {
      this.cardsCacheLoading = this.readCardsFromDisk().then(
        (cache) => {
          this.cardsCache = cache;
          return cache;
        },
        (error: unknown) => {
          // Don't cache a rejected load — a transient read failure would
          // otherwise brick every card operation until the daemon restarts.
          this.cardsCacheLoading = null;
          throw error;
        },
      );
    }
    return this.cardsCacheLoading;
  }

  private async readCardsFromDisk(): Promise<Map<string, StoredKanbanCard>> {
    await this.ensureCardsDir();
    const entries = await readdir(this.cardsDir, { withFileTypes: true });
    const cache = new Map<string, StoredKanbanCard>();
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.cardsDir, entry.name), "utf-8");
          const card = StoredKanbanCardSchema.parse(JSON.parse(content));
          cache.set(card.id, card);
        }),
    );
    await this.backfillMissingColumnIds(cache);
    return cache;
  }

  // Lazily fills in columnId for cards persisted before columns existed, by
  // matching the card's status to a column (see columnMatchForStatus). Only
  // updates the in-memory cache — the next write to a given card (move/
  // update) is what actually persists the backfilled value. The `status`
  // field itself is left untouched, so old clients keep seeing the exact
  // status this card was written with.
  private async backfillMissingColumnIds(cache: Map<string, StoredKanbanCard>): Promise<void> {
    const missing = [...cache.values()].filter((card) => !card.columnId);
    if (missing.length === 0) {
      return;
    }
    const columns = [...(await this.listColumns())].sort((left, right) => left.order - right.order);
    for (const card of missing) {
      const match = this.columnMatchForStatus(columns, card.status);
      if (match) {
        cache.set(card.id, { ...card, columnId: match.id });
      }
    }
  }

  // First column (by order) whose legacyStatus exactly matches; else the
  // first column matching the status-category bucket (skip/fail/abort ->
  // done); else the first non-hidden column; else the first column overall.
  private columnMatchForStatus(
    columnsByOrder: KanbanColumn[],
    status: KanbanStatus,
  ): KanbanColumn | undefined {
    return (
      columnsByOrder.find((column) => column.legacyStatus === status) ??
      columnsByOrder.find((column) => column.legacyStatus === bucketLegacyStatus(status)) ??
      columnsByOrder.find((column) => !column.hidden) ??
      columnsByOrder[0]
    );
  }

  async createCard(input: CreateKanbanCardInput): Promise<StoredKanbanCard> {
    const status = input.status ?? "pending";
    const source: KanbanCardSource = input.source ?? { kind: "manual" };
    // Serialize creates per target column so concurrent adds read a consistent
    // card list and never compute a duplicate `order` for the same status.
    return this.serializeIdentityMutation(`create:${status}`, async () => {
      const now = new Date().toISOString();
      const columnId = await this.columnIdForStatus(status);
      const cards = await this.listCards();
      const card = StoredKanbanCardSchema.parse({
        id: generateCardId(),
        title: input.title,
        url: input.url ?? null,
        status,
        columnId,
        theme: input.theme ?? this.defaultThemeForSource(source),
        source,
        externalId: input.externalId ?? null,
        order: this.nextOrderForColumn(cards, columnId),
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
      const statusChanged = input.status !== undefined && input.status !== current.status;
      const columnId = statusChanged
        ? await this.columnIdForStatus(input.status!)
        : current.columnId;
      const next = StoredKanbanCardSchema.parse({
        ...current,
        title: input.title ?? current.title,
        url: input.url === undefined ? current.url : input.url,
        status: input.status ?? current.status,
        columnId,
        theme: input.theme ?? current.theme,
        order: input.order ?? current.order,
        labels: input.labels ?? current.labels,
        assignee: input.assignee === undefined ? current.assignee : input.assignee,
        priority: input.priority === undefined ? current.priority : input.priority,
        trigger: input.trigger === null ? undefined : (input.trigger ?? current.trigger),
        metadata: input.metadata ?? current.metadata,
        // An explicit status change here is a deliberate user action, so pin it
        // the same way a drag does — otherwise the next source sync reverts it.
        statusPinnedByUser: statusChanged ? true : current.statusPinnedByUser,
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(next);
      return next;
    });
  }

  // Drag-to-column move. Pins statusPinnedByUser only when the card actually
  // changes column/status, so source sync stops overwriting status for this
  // card — an in-column reorder (same target, explicit order) must not pin.
  // When input.columnId is given it takes priority and status is derived from
  // that column's legacyStatus; otherwise (old clients) status alone picks the
  // first column with a matching legacyStatus.
  async moveCard(input: MoveKanbanCardInput): Promise<StoredKanbanCard | null> {
    return this.serializeCardMutation(input.id, async () => {
      const current = await this.getCard(input.id);
      if (!current) {
        return null;
      }
      const { status, columnId } = await this.resolveMoveTarget(input);
      const columnChanged =
        status !== current.status ||
        (current.columnId !== undefined && columnId !== current.columnId);
      const cards = await this.listCards();
      const order =
        input.order ??
        this.nextOrderForColumn(
          cards.filter((card) => card.id !== current.id),
          columnId,
        );
      const next = StoredKanbanCardSchema.parse({
        ...current,
        status,
        columnId,
        order,
        statusPinnedByUser: current.statusPinnedByUser || columnChanged,
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(next);
      return next;
    });
  }

  // Applies the status/column a REAL upstream write (e.g. a Jira transition)
  // already produced. Unlike moveCard/updateCard, this never pins
  // statusPinnedByUser — the tracker is now authoritative for this card's
  // status (the write-back call just changed it there), so there is nothing
  // for a future source sync to diverge from. Explicitly clears any stale pin
  // instead of leaving it, since the reason to keep one (a manual drag/edit
  // that hadn't round-tripped to the tracker) no longer applies once a real
  // write-back has happened.
  async applyExternalTransition(
    cardId: string,
    next: { status: KanbanStatus; columnId: string; metadataStatus?: Record<string, unknown> },
  ): Promise<StoredKanbanCard | null> {
    return this.serializeCardMutation(cardId, async () => {
      const current = await this.getCard(cardId);
      if (!current) {
        return null;
      }
      // Replace only the `status` key inside metadata (the raw Jira status
      // object the board reads name/statusCategory off of) — every other
      // metadata key (assignee, priority, etc.) is left untouched.
      const metadata = next.metadataStatus
        ? { ...current.metadata, status: next.metadataStatus }
        : current.metadata;
      const updated = StoredKanbanCardSchema.parse({
        ...current,
        status: next.status,
        columnId: next.columnId,
        metadata,
        statusPinnedByUser: false,
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(updated);
      return updated;
    });
  }

  private async resolveMoveTarget(
    input: MoveKanbanCardInput,
  ): Promise<{ status: KanbanStatus; columnId: string }> {
    if (input.columnId) {
      const column = await this.getColumn(input.columnId);
      if (!column) {
        throw new Error(`Kanban column not found: ${input.columnId}`);
      }
      return { status: column.legacyStatus, columnId: column.id };
    }
    return { status: input.status, columnId: await this.columnIdForStatus(input.status) };
  }

  // Resolves a column for callers that only know the six fixed statuses (old
  // clients, manual card creation, updateCard status changes) — see
  // columnMatchForStatus for the match/bucket/fallback order.
  private async columnIdForStatus(status: KanbanStatus): Promise<string> {
    const columns = [...(await this.listColumns())].sort((left, right) => left.order - right.order);
    const match = this.columnMatchForStatus(columns, status);
    if (!match) {
      throw new Error(`No kanban column configured for status: ${status}`);
    }
    return match.id;
  }

  async deleteCard(id: string): Promise<boolean> {
    return this.serializeCardMutation(id, async () => {
      const existing = await this.getCard(id);
      if (!existing) {
        return false;
      }
      await this.ensureCardsDir();
      await rm(this.cardFilePath(id), { force: true });
      const cache = await this.loadCardsCache();
      cache.delete(id);
      return true;
    });
  }

  // Idempotent upsert keyed on (source.kind, externalId): existing card is
  // updated, missing card is created. Never duplicates for the same identity.
  async upsertCardBySource(
    source: ExternalKanbanCardSource,
    payload: UpsertKanbanCardBySourcePayload,
  ): Promise<UpsertKanbanCardBySourceResult> {
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
          columnId: payload.columnId,
          theme: payload.theme,
          source,
          externalId: source.externalId,
          sourceId: payload.sourceId,
          order: this.nextOrderForColumn(cards, payload.columnId),
          statusPinnedByUser: false,
          labels: payload.labels,
          assignee: payload.assignee ?? null,
          priority: payload.priority ?? null,
          metadata: payload.metadata,
          sourceCreatedAt: payload.sourceCreatedAt ?? null,
          sourceUpdatedAt: payload.sourceUpdatedAt ?? null,
          hasUnresolvedThreads: payload.hasUnresolvedThreads,
          createdAt: now,
          updatedAt: now,
        });
        await this.writeCard(created);
        return { ...created, created: true };
      }

      const updated = StoredKanbanCardSchema.parse({
        ...existing,
        title: payload.title,
        url: payload.url,
        theme: payload.theme,
        source,
        sourceId: payload.sourceId ?? existing.sourceId,
        // Once the user drags the card, sync stops overwriting status/column —
        // unless this sync forces it (terminal MR merged/closed wins over a
        // manual drag).
        status:
          existing.statusPinnedByUser && !payload.forceStatus ? existing.status : payload.status,
        columnId:
          existing.statusPinnedByUser && !payload.forceStatus
            ? existing.columnId
            : payload.columnId,
        labels: payload.labels ?? existing.labels,
        // The source is authoritative for synced fields: when it reports the
        // ticket as unassigned (payload.assignee === null) clear the card too,
        // rather than keeping a stale assignee. Only a truly omitted (undefined)
        // field falls back to the existing value.
        assignee: payload.assignee === undefined ? existing.assignee : payload.assignee,
        priority: payload.priority === undefined ? existing.priority : payload.priority,
        metadata: payload.metadata ?? existing.metadata,
        sourceCreatedAt: payload.sourceCreatedAt ?? existing.sourceCreatedAt ?? null,
        sourceUpdatedAt: payload.sourceUpdatedAt ?? existing.sourceUpdatedAt ?? null,
        hasUnresolvedThreads: payload.hasUnresolvedThreads,
        updatedAt: now,
      });
      await this.writeCard(updated);
      return { ...updated, created: false };
    });
  }

  private defaultThemeForSource(source: KanbanCardSource): string {
    if (source.kind === "jira") return "jira";
    if (source.kind === "gitlab") return "gitlab-mr";
    return "manual";
  }

  // Cards are ordered within a column, not within a legacy status — several
  // columns can share one legacyStatus, and each needs its own order space.
  private nextOrderForColumn(cards: StoredKanbanCard[], columnId: string): number {
    const inColumn = cards.filter((card) => card.columnId === columnId);
    if (inColumn.length === 0) {
      return 0;
    }
    return Math.max(...inColumn.map((card) => card.order)) + 1;
  }

  private async writeCard(card: StoredKanbanCard): Promise<void> {
    await this.ensureCardsDir();
    await writeJsonFileAtomic(this.cardFilePath(card.id), card);
    const cache = await this.loadCardsCache();
    cache.set(card.id, card);
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
        // Primary route: connectionId (instance + auth live on the connection).
        // baseUrl stays for the legacy CLI path that embeds an instance directly.
        connectionId: input.connectionId ?? null,
        baseUrl: input.baseUrl,
        query: input.query,
        statusMap: input.statusMap,
        columnMap: input.columnMap,
        promptTemplate: input.promptTemplate,
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
        connectionId: input.connectionId === undefined ? current.connectionId : input.connectionId,
        baseUrl: input.baseUrl ?? current.baseUrl,
        query: input.query ?? current.query,
        enabled: input.enabled ?? current.enabled,
        statusMap: input.statusMap === null ? undefined : (input.statusMap ?? current.statusMap),
        columnMap: input.columnMap === null ? undefined : (input.columnMap ?? current.columnMap),
        promptTemplate:
          input.promptTemplate === null
            ? undefined
            : (input.promptTemplate ?? current.promptTemplate),
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
  // Connections — a reusable Jira/GitLab instance + auth (see
  // StoredKanbanConnectionSchema doc comment). Any number of sources may
  // point at one via source.connectionId.
  // -------------------------------------------------------------------------

  async listConnections(): Promise<StoredKanbanConnection[]> {
    await this.ensureDir();
    try {
      const content = await readFile(this.connectionsFile, "utf-8");
      const parsed = JSON.parse(content) as unknown[];
      return parsed
        .map((entry) => StoredKanbanConnectionSchema.parse(entry))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async getConnection(id: string): Promise<StoredKanbanConnection | null> {
    const connections = await this.listConnections();
    return connections.find((connection) => connection.id === id) ?? null;
  }

  async createConnection(input: CreateKanbanConnectionInput): Promise<StoredKanbanConnection> {
    return this.serializeConnectionsMutation(async () => {
      const connections = await this.listConnections();
      const now = new Date().toISOString();
      const created = StoredKanbanConnectionSchema.parse({
        id: generateConnectionId(),
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        email: input.email ?? null,
        oauthClientId: input.oauthClientId ?? null,
        // Secret material (tokenValue/oauthClientSecret) is never persisted here —
        // KanbanService writes it to secrets.json and calls setConnectionAuthConnected.
        authConnected: false,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeConnections([...connections, created]);
      return created;
    });
  }

  async updateConnection(
    input: UpdateKanbanConnectionInput,
  ): Promise<StoredKanbanConnection | null> {
    return this.serializeConnectionsMutation(async () => {
      const connections = await this.listConnections();
      const index = connections.findIndex((connection) => connection.id === input.id);
      if (index === -1) {
        return null;
      }
      const current = connections[index];
      const updated = StoredKanbanConnectionSchema.parse({
        ...current,
        name: input.name ?? current.name,
        baseUrl: input.baseUrl ?? current.baseUrl,
        email: input.email === undefined ? current.email : input.email,
        oauthClientId:
          input.oauthClientId === undefined ? current.oauthClientId : input.oauthClientId,
        updatedAt: new Date().toISOString(),
      });
      const next = [...connections];
      next[index] = updated;
      await this.writeConnections(next);
      return updated;
    });
  }

  // Updates the connected flag after KanbanService writes secret material to
  // secrets.json (create/update/OAuth callback). Not part of the update RPC.
  async setConnectionAuthConnected(
    id: string,
    authConnected: boolean,
  ): Promise<StoredKanbanConnection | null> {
    return this.serializeConnectionsMutation(async () => {
      const connections = await this.listConnections();
      const index = connections.findIndex((connection) => connection.id === id);
      if (index === -1) {
        return null;
      }
      const updated = StoredKanbanConnectionSchema.parse({
        ...connections[index],
        authConnected,
        updatedAt: new Date().toISOString(),
      });
      const next = [...connections];
      next[index] = updated;
      await this.writeConnections(next);
      return updated;
    });
  }

  async deleteConnection(id: string): Promise<boolean> {
    return this.serializeConnectionsMutation(async () => {
      const connections = await this.listConnections();
      const next = connections.filter((connection) => connection.id !== id);
      if (next.length === connections.length) {
        return false;
      }
      await this.writeConnections(next);
      return true;
    });
  }

  private async writeConnections(connections: StoredKanbanConnection[]): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.connectionsFile, connections);
  }

  // -------------------------------------------------------------------------
  // Columns — Jira-style configurable board columns. columns.json is
  // migrated lazily: the first read of a $PASEO_HOME without the file
  // generates the three default status-category columns (see DEFAULT_COLUMNS)
  // and persists them immediately, under COLUMNS_LOCK so concurrent
  // first-reads can't race into duplicate migrations.
  // -------------------------------------------------------------------------

  async listColumns(): Promise<KanbanColumn[]> {
    await this.ensureDir();
    try {
      return await this.readColumnsFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.serializeColumnsMutation(() => this.migrateDefaultColumns());
      }
      throw error;
    }
  }

  async getColumn(id: string): Promise<KanbanColumn | null> {
    const columns = await this.listColumns();
    return columns.find((column) => column.id === id) ?? null;
  }

  async createColumn(input: CreateKanbanColumnInput): Promise<KanbanColumn> {
    return this.serializeColumnsMutation(async () => {
      const columns = await this.readColumnsUnderLock();
      const maxOrder = columns.length > 0 ? Math.max(...columns.map((column) => column.order)) : -1;
      const created = KanbanColumnSchema.parse({
        id: generateColumnId(),
        title: input.title,
        order: input.order ?? maxOrder + 1,
        hidden: input.hidden ?? false,
        legacyStatus: input.legacyStatus,
      });
      await this.writeColumns([...columns, created]);
      return created;
    });
  }

  async updateColumn(input: UpdateKanbanColumnInput): Promise<KanbanColumn | null> {
    return this.serializeColumnsMutation(async () => {
      const columns = await this.readColumnsUnderLock();
      const index = columns.findIndex((column) => column.id === input.id);
      if (index === -1) {
        return null;
      }
      const current = columns[index];
      const updated = KanbanColumnSchema.parse({
        ...current,
        title: input.title ?? current.title,
        hidden: input.hidden ?? current.hidden,
        legacyStatus: input.legacyStatus ?? current.legacyStatus,
      });
      const next = [...columns];
      next[index] = updated;
      await this.writeColumns(next);
      return updated;
    });
  }

  async reorderColumn(input: ReorderKanbanColumnInput): Promise<KanbanColumn | null> {
    return this.serializeColumnsMutation(async () => {
      const columns = await this.readColumnsUnderLock();
      const index = columns.findIndex((column) => column.id === input.id);
      if (index === -1) {
        return null;
      }
      const updated = KanbanColumnSchema.parse({ ...columns[index], order: input.order });
      const next = [...columns];
      next[index] = updated;
      await this.writeColumns(next);
      return updated;
    });
  }

  // Removes a column, moving every card currently in it to
  // moveCardsToColumnId first. Card reassignment goes through
  // serializeCardMutation per card (not moveCard, which would try to
  // re-acquire COLUMNS_LOCK via getColumn and deadlock against the lock this
  // method already holds).
  async deleteColumn(input: DeleteKanbanColumnInput): Promise<boolean> {
    if (input.id === input.moveCardsToColumnId) {
      throw new Error("moveCardsToColumnId must differ from the column being deleted");
    }
    return this.serializeColumnsMutation(async () => {
      const columns = await this.readColumnsUnderLock();
      if (!columns.some((column) => column.id === input.id)) {
        return false;
      }
      const target = columns.find((column) => column.id === input.moveCardsToColumnId);
      if (!target) {
        throw new Error(`Kanban column not found: ${input.moveCardsToColumnId}`);
      }
      const affected = (await this.listCards()).filter((card) => card.columnId === input.id);
      for (const card of affected) {
        await this.reassignCardToColumn(card.id, target);
      }
      await this.writeColumns(columns.filter((column) => column.id !== input.id));
      return true;
    });
  }

  private async reassignCardToColumn(cardId: string, target: KanbanColumn): Promise<void> {
    await this.serializeCardMutation(cardId, async () => {
      const current = await this.getCard(cardId);
      if (!current) {
        return;
      }
      const siblings = (await this.listCards()).filter((card) => card.id !== current.id);
      const next = StoredKanbanCardSchema.parse({
        ...current,
        status: target.legacyStatus,
        columnId: target.id,
        order: this.nextOrderForColumn(siblings, target.id),
        updatedAt: new Date().toISOString(),
      });
      await this.writeCard(next);
    });
  }

  // Resolves the column a sync upsert should land a card in. Never creates a
  // column — a real Jira project can report a dozen-plus distinct status
  // names, so sync targets the status-category bucket instead of minting a
  // column per unmapped name. Priority: columnIdOverride (source.columnMap)
  // > a legacy KanbanStatus override (source.statusMap, matched to the first
  // column with that exact legacyStatus) > categoryLegacyStatus (the
  // Jira/GitLab status-category bucket, same matching) > the first
  // non-hidden column > the first column overall.
  async resolveColumnForSync(input: {
    columnIdOverride?: string;
    legacyStatusOverride?: KanbanStatus;
    categoryLegacyStatus: KanbanStatus;
  }): Promise<KanbanColumn> {
    const columns = [...(await this.listColumns())].sort((left, right) => left.order - right.order);
    if (input.columnIdOverride) {
      const direct = columns.find((column) => column.id === input.columnIdOverride);
      if (direct) {
        return direct;
      }
    }
    if (input.legacyStatusOverride) {
      const byLegacyStatus = columns.find(
        (column) => column.legacyStatus === input.legacyStatusOverride,
      );
      if (byLegacyStatus) {
        return byLegacyStatus;
      }
    }
    const byCategory = columns.find((column) => column.legacyStatus === input.categoryLegacyStatus);
    if (byCategory) {
      return byCategory;
    }
    const fallback = columns.find((column) => !column.hidden) ?? columns[0];
    if (!fallback) {
      throw new Error("No kanban columns configured");
    }
    return fallback;
  }

  private async readColumnsFile(): Promise<KanbanColumn[]> {
    const content = await readFile(this.columnsFile, "utf-8");
    const parsed = JSON.parse(content) as unknown[];
    return parsed
      .map((entry) => KanbanColumnSchema.parse(entry))
      .sort((left, right) => left.order - right.order);
  }

  // Assumes COLUMNS_LOCK is already held by the caller (create/update/reorder/
  // delete bodies). Never re-acquires the lock itself, so it can safely run
  // the ENOENT migration inline instead of calling the public listColumns(),
  // which would deadlock.
  private async readColumnsUnderLock(): Promise<KanbanColumn[]> {
    try {
      return await this.readColumnsFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return this.migrateDefaultColumns();
  }

  // Assumes COLUMNS_LOCK is already held by the caller.
  private async migrateDefaultColumns(): Promise<KanbanColumn[]> {
    // Re-check: another concurrent caller may have migrated already while we
    // were waiting for the lock.
    try {
      return await this.readColumnsFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const columns = DEFAULT_COLUMNS.map((def, index) =>
      KanbanColumnSchema.parse({
        id: generateColumnId(),
        title: def.title,
        order: index,
        hidden: false,
        legacyStatus: def.legacyStatus,
      }),
    );
    await this.writeColumns(columns);
    return columns;
  }

  private async writeColumns(columns: KanbanColumn[]): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.columnsFile, columns);
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

  private async serializeConnectionsMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(
      this.connectionsMutations,
      KanbanStore.CONNECTIONS_LOCK,
      mutation,
    );
  }

  private async serializeColumnsMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return this.serializeMutation(this.columnsMutations, KanbanStore.COLUMNS_LOCK, mutation);
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
