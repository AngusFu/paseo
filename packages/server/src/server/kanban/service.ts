import type pino from "pino";
import type {
  CreateKanbanCardInput,
  CreateKanbanColumnInput,
  CreateKanbanConnectionInput,
  CreateKanbanSourceInput,
  DeleteKanbanColumnInput,
  KanbanCardDetail,
  KanbanColumn,
  KanbanExternalStatus,
  MoveKanbanCardInput,
  ReorderKanbanColumnInput,
  StoredKanbanCard,
  StoredKanbanConnection,
  StoredKanbanSource,
  UpdateKanbanCardInput,
  UpdateKanbanColumnInput,
  UpdateKanbanConnectionInput,
  UpdateKanbanSourceInput,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import { KanbanSyncService } from "./sync.js";
import { KanbanCardDetailService } from "./detail.js";
import { KanbanSecretsStore, type KanbanOauthSecret, type KanbanSecret } from "./secrets-store.js";
import { credentialRefForConnection, KanbanOauthService } from "./oauth.js";
import { KanbanPollService } from "./poll.js";

// Merge a client id + optional new secret into an OAuth secret, preserving any
// tokens already issued for this connection. Extracted so applyConnectionSecrets
// stays under the complexity limit.
function buildOauthSecret(
  clientId: string,
  clientSecretInput: string | null | undefined,
  existing: KanbanSecret | null,
): KanbanOauthSecret {
  const prior = existing?.method === "oauth" ? existing : null;
  return {
    method: "oauth",
    clientId,
    clientSecret: clientSecretInput ?? prior?.clientSecret ?? "",
    accessToken: prior?.accessToken ?? null,
    refreshToken: prior?.refreshToken ?? null,
    expiresAt: prior?.expiresAt ?? null,
  };
}

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

export interface KanbanCardDetailResult {
  detail: KanbanCardDetail | null;
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

export interface KanbanConnectionResult {
  connection: StoredKanbanConnection | null;
  error: string | null;
}

export interface KanbanConnectionListResult {
  connections: StoredKanbanConnection[];
  error: string | null;
}

export interface KanbanConnectionDeleteResult {
  connectionId: string;
  error: string | null;
}

export interface KanbanConnectionOauthStartResult {
  authorizeUrl: string | null;
  error: string | null;
}

export interface KanbanColumnResult {
  column: KanbanColumn | null;
  error: string | null;
}

export interface KanbanColumnListResult {
  columns: KanbanColumn[];
  error: string | null;
}

export interface KanbanColumnDeleteResult {
  columnId: string;
  error: string | null;
}

export interface KanbanSourceListExternalStatusesResult {
  statuses: KanbanExternalStatus[];
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

// Secret-bearing fields on Create/UpdateKanbanConnectionInput. Never
// persisted on StoredKanbanConnection — written to secrets.json and replaced
// with a credentialRef-keyed entry before the connection row is stored.
interface ConnectionSecretInput {
  tokenValue?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
}

// Wraps KanbanStore + KanbanSyncService + KanbanOauthService + KanbanPollService
// with one handler per RPC. Handlers never throw — failures come back as
// { ..., error: string } so session.ts can emit the response payload directly
// without its own try/catch.
export class KanbanService {
  private readonly store: KanbanStore;
  private readonly secretsStore: KanbanSecretsStore;
  private readonly syncService: KanbanSyncService;
  private readonly detailService: KanbanCardDetailService;
  private readonly oauthService: KanbanOauthService;
  private readonly pollService: KanbanPollService;

  constructor(options: KanbanServiceOptions) {
    this.store = new KanbanStore(options.dir);
    this.secretsStore = new KanbanSecretsStore(options.dir);
    const fetchImpl = options.fetchImpl ?? fetch;
    this.oauthService = new KanbanOauthService({
      store: this.store,
      secrets: this.secretsStore,
      fetchImpl,
      logger: options.logger,
    });
    this.syncService = new KanbanSyncService({
      store: this.store,
      secrets: this.secretsStore,
      fetchImpl,
      oauthService: this.oauthService,
      logger: options.logger,
    });
    this.detailService = new KanbanCardDetailService({
      store: this.store,
      secrets: this.secretsStore,
      fetchImpl,
      oauthService: this.oauthService,
      logger: options.logger,
    });
    this.pollService = new KanbanPollService({
      store: this.store,
      syncService: this.syncService,
      logger: options.logger,
    });
  }

  // Starts the per-source poll timer (checks sources against their
  // pollEverySec every few seconds). Safe to call multiple times.
  startPolling(): void {
    this.pollService.start();
  }

  stopPolling(): void {
    this.pollService.stop();
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

  async detailCard(cardId: string): Promise<KanbanCardDetailResult> {
    return this.detailService.getDetail(cardId);
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

  async listExternalStatuses(
    sourceId: string,
    projectKey?: string,
  ): Promise<KanbanSourceListExternalStatusesResult> {
    try {
      const source = await this.store.getSource(sourceId);
      if (!source) {
        return { statuses: [], error: `Kanban source not found: ${sourceId}` };
      }
      const statuses = await this.syncService.listExternalStatuses(source, projectKey);
      return { statuses, error: null };
    } catch (error) {
      return { statuses: [], error: errorMessage(error) };
    }
  }

  async listColumns(): Promise<KanbanColumnListResult> {
    try {
      const columns = await this.store.listColumns();
      return { columns, error: null };
    } catch (error) {
      return { columns: [], error: errorMessage(error) };
    }
  }

  async createColumn(input: CreateKanbanColumnInput): Promise<KanbanColumnResult> {
    try {
      const column = await this.store.createColumn(input);
      return { column, error: null };
    } catch (error) {
      return { column: null, error: errorMessage(error) };
    }
  }

  async updateColumn(input: UpdateKanbanColumnInput): Promise<KanbanColumnResult> {
    try {
      const column = await this.store.updateColumn(input);
      return { column, error: column ? null : `Kanban column not found: ${input.id}` };
    } catch (error) {
      return { column: null, error: errorMessage(error) };
    }
  }

  async reorderColumn(input: ReorderKanbanColumnInput): Promise<KanbanColumnResult> {
    try {
      const column = await this.store.reorderColumn(input);
      return { column, error: column ? null : `Kanban column not found: ${input.id}` };
    } catch (error) {
      return { column: null, error: errorMessage(error) };
    }
  }

  async deleteColumn(input: DeleteKanbanColumnInput): Promise<KanbanColumnDeleteResult> {
    try {
      const deleted = await this.store.deleteColumn(input);
      return { columnId: input.id, error: deleted ? null : `Kanban column not found: ${input.id}` };
    } catch (error) {
      return { columnId: input.id, error: errorMessage(error) };
    }
  }

  async createConnection(input: CreateKanbanConnectionInput): Promise<KanbanConnectionResult> {
    try {
      const created = await this.store.createConnection(input);
      const connection = await this.applyConnectionSecrets(created, input);
      return { connection, error: null };
    } catch (error) {
      return { connection: null, error: errorMessage(error) };
    }
  }

  async listConnections(): Promise<KanbanConnectionListResult> {
    try {
      const connections = await this.store.listConnections();
      return { connections, error: null };
    } catch (error) {
      return { connections: [], error: errorMessage(error) };
    }
  }

  async updateConnection(input: UpdateKanbanConnectionInput): Promise<KanbanConnectionResult> {
    try {
      const updated = await this.store.updateConnection(input);
      if (!updated) {
        return { connection: null, error: `Kanban connection not found: ${input.id}` };
      }
      const connection = await this.applyConnectionSecrets(updated, input);
      return { connection, error: null };
    } catch (error) {
      return { connection: null, error: errorMessage(error) };
    }
  }

  async deleteConnection(connectionId: string): Promise<KanbanConnectionDeleteResult> {
    try {
      const deleted = await this.store.deleteConnection(connectionId);
      if (deleted) {
        await this.secretsStore.delete(credentialRefForConnection(connectionId));
      }
      return {
        connectionId,
        error: deleted ? null : `Kanban connection not found: ${connectionId}`,
      };
    } catch (error) {
      return { connectionId, error: errorMessage(error) };
    }
  }

  // Begins an OAuth authorization-code flow for a connection: returns the
  // provider authorize URL the client should open. redirectUri is the
  // daemon's own loopback callback route, computed by the caller (session.ts
  // knows the bound TCP host/port; this service does not).
  async startOauth(
    connectionId: string,
    redirectUri: string,
  ): Promise<KanbanConnectionOauthStartResult> {
    try {
      const connection = await this.store.getConnection(connectionId);
      if (!connection) {
        return { authorizeUrl: null, error: `Kanban connection not found: ${connectionId}` };
      }
      const { authorizeUrl } = this.oauthService.startAuthorization(connection, redirectUri);
      return { authorizeUrl, error: null };
    } catch (error) {
      return { authorizeUrl: null, error: errorMessage(error) };
    }
  }

  // Called by the daemon's /kanban/oauth/callback HTTP route (not an RPC —
  // the provider redirects the user's browser here directly).
  async handleOauthCallback(params: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{ connectionId: string }> {
    return this.oauthService.handleCallback(params);
  }

  // Writes tokenValue/oauthClientSecret to secrets.json and flips
  // authConnected via setConnectionAuthConnected. Secret material itself is
  // never returned or stored on StoredKanbanConnection.
  //
  // Precedence when a caller (create or update) supplies more than one
  // secret-shaped field: a non-empty tokenValue wins (PAT auth) and marks the
  // connection connected immediately; a non-empty oauthClientId stores/updates
  // the OAuth app config but leaves authConnected alone unless a token is
  // already on file (not "connected" until the callback completes); an
  // explicit null on either clears the credential. Omitting both leaves the
  // existing credential untouched.
  private async applyConnectionSecrets(
    connection: StoredKanbanConnection,
    input: ConnectionSecretInput,
  ): Promise<StoredKanbanConnection> {
    const credentialRef = credentialRefForConnection(connection.id);

    if (typeof input.tokenValue === "string" && input.tokenValue.length > 0) {
      await this.secretsStore.set(credentialRef, { method: "token", token: input.tokenValue });
      const updated = await this.store.setConnectionAuthConnected(connection.id, true);
      return updated ?? connection;
    }

    if (typeof input.oauthClientId === "string" && input.oauthClientId.length > 0) {
      const existing = await this.secretsStore.get(credentialRef);
      const hasToken = existing?.method === "oauth" && existing.accessToken != null;
      const secret = buildOauthSecret(input.oauthClientId, input.oauthClientSecret, existing);
      await this.secretsStore.set(credentialRef, secret);
      const updated = await this.store.setConnectionAuthConnected(connection.id, hasToken);
      return updated ?? connection;
    }

    if (input.tokenValue === null || input.oauthClientId === null) {
      await this.secretsStore.delete(credentialRef);
      const updated = await this.store.setConnectionAuthConnected(connection.id, false);
      return updated ?? connection;
    }

    return connection;
  }
}
