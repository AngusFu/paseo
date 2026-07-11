import type pino from "pino";
import type {
  CreateKanbanCardInput,
  CreateKanbanSourceInput,
  MoveKanbanCardInput,
  StoredKanbanCard,
  StoredKanbanSource,
  UpdateKanbanCardInput,
  UpdateKanbanSourceInput,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import { KanbanSyncService } from "./sync.js";

export interface KanbanCardResult {
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardListResult {
  cards: StoredKanbanCard[];
  error: string | null;
}

export interface KanbanCardDeleteResult {
  cardId: string;
  error: string | null;
}

export interface KanbanSourceResult {
  source: StoredKanbanSource | null;
  error: string | null;
}

export interface KanbanSourceListResult {
  sources: StoredKanbanSource[];
  error: string | null;
}

export interface KanbanSourceDeleteResult {
  sourceId: string;
  error: string | null;
}

export interface KanbanSourceSyncResult {
  source: StoredKanbanSource | null;
  cards: StoredKanbanCard[];
  upsertedCount: number;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface KanbanServiceOptions {
  dir: string;
  fetchImpl?: typeof fetch;
  logger?: pino.Logger;
}

// Wraps KanbanStore + KanbanSyncService with one handler per RPC. Handlers
// never throw — failures come back as { ..., error: string } so session.ts
// can emit the response payload directly without its own try/catch.
export class KanbanService {
  private readonly store: KanbanStore;
  private readonly syncService: KanbanSyncService;

  constructor(options: KanbanServiceOptions) {
    this.store = new KanbanStore(options.dir);
    this.syncService = new KanbanSyncService({
      store: this.store,
      fetchImpl: options.fetchImpl ?? fetch,
      logger: options.logger,
    });
  }

  async createCard(input: CreateKanbanCardInput): Promise<KanbanCardResult> {
    try {
      const card = await this.store.createCard(input);
      return { card, error: null };
    } catch (error) {
      return { card: null, error: errorMessage(error) };
    }
  }

  async listCards(): Promise<KanbanCardListResult> {
    try {
      const cards = await this.store.listCards();
      return { cards, error: null };
    } catch (error) {
      return { cards: [], error: errorMessage(error) };
    }
  }

  async inspectCard(cardId: string): Promise<KanbanCardResult> {
    try {
      const card = await this.store.getCard(cardId);
      return { card, error: card ? null : `Kanban card not found: ${cardId}` };
    } catch (error) {
      return { card: null, error: errorMessage(error) };
    }
  }

  async updateCard(input: UpdateKanbanCardInput): Promise<KanbanCardResult> {
    try {
      const card = await this.store.updateCard(input);
      return { card, error: card ? null : `Kanban card not found: ${input.id}` };
    } catch (error) {
      return { card: null, error: errorMessage(error) };
    }
  }

  async moveCard(input: MoveKanbanCardInput): Promise<KanbanCardResult> {
    try {
      const card = await this.store.moveCard(input);
      return { card, error: card ? null : `Kanban card not found: ${input.id}` };
    } catch (error) {
      return { card: null, error: errorMessage(error) };
    }
  }

  async deleteCard(cardId: string): Promise<KanbanCardDeleteResult> {
    try {
      const deleted = await this.store.deleteCard(cardId);
      return { cardId, error: deleted ? null : `Kanban card not found: ${cardId}` };
    } catch (error) {
      return { cardId, error: errorMessage(error) };
    }
  }

  async createSource(input: CreateKanbanSourceInput): Promise<KanbanSourceResult> {
    try {
      const source = await this.store.createSource(input);
      return { source, error: null };
    } catch (error) {
      return { source: null, error: errorMessage(error) };
    }
  }

  async listSources(): Promise<KanbanSourceListResult> {
    try {
      const sources = await this.store.listSources();
      return { sources, error: null };
    } catch (error) {
      return { sources: [], error: errorMessage(error) };
    }
  }

  async updateSource(input: UpdateKanbanSourceInput): Promise<KanbanSourceResult> {
    try {
      const source = await this.store.updateSource(input);
      return { source, error: source ? null : `Kanban source not found: ${input.id}` };
    } catch (error) {
      return { source: null, error: errorMessage(error) };
    }
  }

  async deleteSource(sourceId: string): Promise<KanbanSourceDeleteResult> {
    try {
      const deleted = await this.store.deleteSource(sourceId);
      return { sourceId, error: deleted ? null : `Kanban source not found: ${sourceId}` };
    } catch (error) {
      return { sourceId, error: errorMessage(error) };
    }
  }

  async syncSource(sourceId: string): Promise<KanbanSourceSyncResult> {
    try {
      const source = await this.store.getSource(sourceId);
      if (!source) {
        return {
          source: null,
          cards: [],
          upsertedCount: 0,
          error: `Kanban source not found: ${sourceId}`,
        };
      }
      const result = await this.syncService.sync(source);
      return {
        source: result.source,
        cards: result.cards,
        upsertedCount: result.cards.length,
        error: result.error,
      };
    } catch (error) {
      return { source: null, cards: [], upsertedCount: 0, error: errorMessage(error) };
    }
  }
}
