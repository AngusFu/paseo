/**
 * Full workflow status list for a Jira source — every status Jira's
 * workflow defines for the source's project(s), not just the statuses
 * currently present on synced cards. Lets the app pre-build a lane/column
 * for every status (including ones with zero cards right now), which the
 * per-card-derived lanes in kanban-jira-board.tsx can't do on their own.
 *
 * Jira-only (gitlab/manual sources reject with an explicit error — the app's
 * GitLab tab uses a fixed four-lane set and never calls this).
 */
import type pino from "pino";
import type {
  KanbanExternalStatus,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { jiraAuthHeaders, resolveKanbanToken, trimTrailingSlash } from "./credentials.js";
import { resolveSourceForCard } from "./card-context.js";
import { parseJiraStatusesResponse } from "./sync.js";

export interface KanbanSourceStatusesResult {
  statuses: KanbanExternalStatus[] | null;
  error: string | null;
}

export interface KanbanSourceStatusServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  oauthService?: KanbanOauthService;
  logger?: pino.Logger;
  // Overridable for tests; defaults to 5 minutes.
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  statuses: KanbanExternalStatus[];
  fetchedAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Jira issue keys are "{PROJECT}-{number}" — project.split("-")[0] on the
// source-side project field mirrors what sync.ts already does when it first
// builds the card's source (issue.key.split("-")[0]); this just re-derives it
// from whichever of the two the card happens to carry.
function projectKeyForJiraCard(
  source: Extract<StoredKanbanCard["source"], { kind: "jira" }>,
): string | null {
  if (source.project) {
    return source.project;
  }
  const key = source.issueKey.split("-")[0];
  return key ? key : null;
}

export class KanbanSourceStatusService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: KanbanSourceStatusServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async listStatuses(sourceId: string): Promise<KanbanSourceStatusesResult> {
    try {
      const source = await this.store.getSource(sourceId);
      if (!source) {
        return { statuses: null, error: `Kanban source not found: ${sourceId}` };
      }
      if (source.kind !== "jira") {
        return { statuses: null, error: "This action is only available for Jira sources" };
      }
      const cached = this.cache.get(sourceId);
      if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
        return { statuses: cached.statuses, error: null };
      }
      const statuses = await this.fetchAllProjectStatuses(source);
      this.cache.set(sourceId, { statuses, fetchedAt: Date.now() });
      return { statuses, error: null };
    } catch (error) {
      this.logger?.warn({ err: error, sourceId }, "Kanban source statuses fetch failed");
      return { statuses: null, error: errorMessage(error) };
    }
  }

  private async fetchAllProjectStatuses(
    source: StoredKanbanSource,
  ): Promise<KanbanExternalStatus[]> {
    const projectKeys = await this.projectKeysForSource(source);
    if (projectKeys.length === 0) {
      return [];
    }
    const connection = source.connectionId
      ? await this.store.getConnection(source.connectionId)
      : null;
    const baseUrl = connection?.baseUrl ?? source.baseUrl;
    if (!baseUrl) {
      throw new Error("Kanban source has no connection and no baseUrl configured");
    }
    const token = await resolveKanbanToken({
      source,
      connection,
      secrets: this.secrets,
      oauthService: this.oauthService,
    });
    const headers = jiraAuthHeaders(token, connection?.email ?? null);
    // Same Cloud/Server detection card-detail/write-back use.
    const apiVersion = connection?.email ? "3" : "2";
    const base = trimTrailingSlash(baseUrl);

    const byName = new Map<string, KanbanExternalStatus>();
    for (const projectKey of projectKeys) {
      const url = `${base}/rest/api/${apiVersion}/project/${encodeURIComponent(projectKey)}/statuses`;
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        // Best-effort per project: a renamed/deleted project key must not
        // blank the whole merged list for every other project this source
        // still has valid cards for.
        this.logger?.warn(
          { sourceId: source.id, projectKey, status: response.status },
          "Kanban project statuses fetch failed",
        );
        continue;
      }
      const body = (await response.json()) as unknown;
      for (const status of parseJiraStatusesResponse(body)) {
        if (!byName.has(status.name)) {
          byName.set(status.name, status);
        }
      }
    }
    return [...byName.values()];
  }

  // Every distinct Jira project key among this source's own cards — matched
  // via card.sourceId when the card has one, falling back to the same
  // kind+baseUrl heuristic card-context.ts uses for older cards synced
  // before sourceId existed.
  private async projectKeysForSource(source: StoredKanbanSource): Promise<string[]> {
    const cards = await this.store.listCards();
    const keys = new Set<string>();
    for (const card of cards) {
      if (card.source.kind !== "jira") {
        continue;
      }
      const ownerId = card.sourceId ?? (await resolveSourceForCard(this.store, card)).id;
      if (ownerId !== source.id) {
        continue;
      }
      const key = projectKeyForJiraCard(card.source);
      if (key) {
        keys.add(key);
      }
    }
    return [...keys];
  }
}
