import type pino from "pino";
import type {
  KanbanCardSource,
  KanbanStatus,
  StoredKanbanCard,
  StoredKanbanConnection,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore, type UpsertKanbanCardBySourcePayload } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import { credentialRefForConnection, type KanbanOauthService } from "./oauth.js";

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    labels?: string[];
    [key: string]: unknown;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

interface GitlabMergeRequest {
  iid: number | string;
  project_id: number | string;
  title: string;
  web_url?: string;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  labels?: string[];
  assignee?: { name?: string } | null;
  head_pipeline?: { status?: string } | null;
}

const JIRA_DEFAULT_STATUS_MAP: Record<string, KanbanStatus> = {
  "To Do": "pending",
  Open: "pending",
  Backlog: "pending",
  "In Progress": "wip",
  Done: "done",
  Closed: "done",
  "Won't Do": "skip",
  Blocked: "fail",
};

const GITLAB_DEFAULT_STATUS_MAP: Record<string, KanbanStatus> = {
  opened_draft: "pending",
  opened: "wip",
  merged: "done",
  closed: "skip",
  pipeline_failed: "fail",
};

function mapExternalStatus(
  externalStatusKey: string,
  defaultMap: Record<string, KanbanStatus>,
  override: Record<string, KanbanStatus> | undefined,
): KanbanStatus {
  return override?.[externalStatusKey] ?? defaultMap[externalStatusKey] ?? "pending";
}

// GitLab MR list responses don't carry one canonical "status" field the way
// Jira does — derive an override-table key from state/draft/pipeline instead.
function gitlabExternalStatusKey(mr: GitlabMergeRequest): string {
  if (mr.state === "merged") return "merged";
  if (mr.state === "closed") return "closed";
  if (mr.head_pipeline?.status === "failed") return "pipeline_failed";
  if (mr.draft || mr.work_in_progress) return "opened_draft";
  return "opened";
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface KanbanSyncResult {
  source: StoredKanbanSource | null;
  cards: StoredKanbanCard[];
  error: string | null;
}

export interface KanbanSyncServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  // Only needed to refresh an expiring OAuth access token before use. Sync
  // still works without it — it just uses whatever access token is on hand.
  oauthService?: KanbanOauthService;
  logger?: pino.Logger;
}

// An access token is refreshed once it's within this window of expiring,
// rather than waiting for the provider to reject an already-stale request.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class KanbanSyncService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;

  constructor(options: KanbanSyncServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
  }

  async sync(source: StoredKanbanSource): Promise<KanbanSyncResult> {
    try {
      const connection = source.connectionId
        ? await this.store.getConnection(source.connectionId)
        : null;
      if (source.connectionId && !connection) {
        throw new Error(`Kanban connection not found: ${source.connectionId}`);
      }
      const baseUrl = connection?.baseUrl ?? source.baseUrl;
      if (!baseUrl) {
        throw new Error("Kanban source has no connection and no baseUrl configured");
      }

      const token = await this.resolveToken(source, connection);
      const upserts =
        source.kind === "jira"
          ? (
              await this.fetchJiraIssues(baseUrl, source.query, token, connection?.email ?? null)
            ).map((issue) => this.buildJiraUpsert(baseUrl, source, issue))
          : (await this.fetchGitlabMergeRequests(baseUrl, source.query, token)).map((mr) =>
              this.buildGitlabUpsert(baseUrl, source, mr),
            );

      const cards: StoredKanbanCard[] = [];
      for (const { cardSource, payload } of upserts) {
        cards.push(await this.store.upsertCardBySource(cardSource, payload));
      }

      const updatedSource = await this.store.recordSourceSync(source.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null,
      });
      return { source: updatedSource, cards, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error, sourceId: source.id }, "Kanban source sync failed");
      const updatedSource = await this.store
        .recordSourceSync(source.id, {
          lastSyncAt: new Date().toISOString(),
          lastSyncError: message,
        })
        .catch(() => null);
      return { source: updatedSource, cards: [], error: message };
    }
  }

  // Resolves the bearer/PAT value to send upstream. Primary route: the source
  // points at a reusable connection, whose credential is keyed by
  // credentialRefForConnection(connection.id) — refreshes an about-to-expire
  // OAuth token first. Legacy route (no connection): looks up
  // source.auth.credentialRef directly, falling back to an env var of the
  // same name for scripts/tests that configure credentials that way
  // (COMPAT(kanbanCredentials): pre-secrets-store v1 behavior, kept as a
  // fallback rather than removed).
  private async resolveToken(
    source: StoredKanbanSource,
    connection: StoredKanbanConnection | null,
  ): Promise<string | null> {
    if (connection) {
      return this.resolveConnectionToken(connection);
    }
    if (!source.auth) {
      return null;
    }
    const secret = await this.secrets.get(source.auth.credentialRef);
    if (!secret) {
      const envValue = process.env[source.auth.credentialRef];
      return envValue && envValue.length > 0 ? envValue : null;
    }
    return secret.method === "token" ? secret.token : secret.accessToken;
  }

  private async resolveConnectionToken(connection: StoredKanbanConnection): Promise<string | null> {
    const secret = await this.secrets.get(credentialRefForConnection(connection.id));
    if (!secret) {
      return null;
    }
    if (secret.method === "token") {
      return secret.token;
    }
    const expiringSoon =
      secret.expiresAt !== null &&
      new Date(secret.expiresAt).getTime() - Date.now() < TOKEN_REFRESH_SKEW_MS;
    if (expiringSoon && secret.refreshToken && this.oauthService) {
      const refreshed = await this.oauthService.refreshAccessToken(connection, secret);
      return refreshed.accessToken;
    }
    return secret.accessToken;
  }

  private async fetchJiraIssues(
    baseUrl: string,
    query: string,
    token: string | null,
    email: string | null,
  ): Promise<JiraIssue[]> {
    const base = trimTrailingSlash(baseUrl);
    // An email means Jira Cloud (HTTP Basic auth). Jira Cloud removed the old
    // GET /rest/api/2/search (returns 410 Gone) in favour of the enhanced-JQL
    // /rest/api/3/search/jql, which returns only id/key unless `fields` is given.
    // Jira Server/DC (Bearer PAT, no email) still uses /rest/api/2/search.
    const jql = encodeURIComponent(query);
    const url = email
      ? `${base}/rest/api/3/search/jql?jql=${jql}&fields=${encodeURIComponent("summary,status,assignee,labels")}&maxResults=100`
      : `${base}/rest/api/2/search?jql=${jql}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      // Jira Cloud REST auth is HTTP Basic base64(email:apiToken). Jira Server/DC
      // Personal Access Tokens use Bearer, so fall back to Bearer without an email.
      headers.Authorization = email
        ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
        : `Bearer ${token}`;
    }
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`Jira sync request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as JiraSearchResponse;
    return body.issues ?? [];
  }

  private async fetchGitlabMergeRequests(
    baseUrl: string,
    query: string,
    token: string | null,
  ): Promise<GitlabMergeRequest[]> {
    const url = `${trimTrailingSlash(baseUrl)}/api/v4/merge_requests?${query}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`GitLab sync request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as GitlabMergeRequest[];
    return body ?? [];
  }

  private buildJiraUpsert(
    baseUrl: string,
    source: StoredKanbanSource,
    issue: JiraIssue,
  ): {
    cardSource: Extract<KanbanCardSource, { kind: "jira" }>;
    payload: UpsertKanbanCardBySourcePayload;
  } {
    const externalId = `jira:${issue.key}`;
    const externalStatus = issue.fields?.status?.name ?? "";
    return {
      cardSource: {
        kind: "jira",
        externalId,
        project: issue.key.split("-")[0],
        issueKey: issue.key,
      },
      payload: {
        title: issue.fields?.summary ?? issue.key,
        url: `${trimTrailingSlash(baseUrl)}/browse/${issue.key}`,
        status: mapExternalStatus(externalStatus, JIRA_DEFAULT_STATUS_MAP, source.statusMap),
        theme: "jira",
        labels: issue.fields?.labels,
        assignee: issue.fields?.assignee?.displayName ?? null,
        metadata: issue.fields as Record<string, unknown> | undefined,
      },
    };
  }

  private buildGitlabUpsert(
    baseUrl: string,
    source: StoredKanbanSource,
    mr: GitlabMergeRequest,
  ): {
    cardSource: Extract<KanbanCardSource, { kind: "gitlab" }>;
    payload: UpsertKanbanCardBySourcePayload;
  } {
    const projectId = String(mr.project_id);
    const mrIid = String(mr.iid);
    const externalId = `gitlab:${projectId}!${mrIid}`;
    const externalStatusKey = gitlabExternalStatusKey(mr);
    return {
      cardSource: {
        kind: "gitlab",
        externalId,
        projectId,
        mrIid,
      },
      payload: {
        title: mr.title,
        url: mr.web_url ?? `${trimTrailingSlash(baseUrl)}/-/merge_requests/${mrIid}`,
        status: mapExternalStatus(externalStatusKey, GITLAB_DEFAULT_STATUS_MAP, source.statusMap),
        theme: "gitlab-mr",
        labels: mr.labels,
        assignee: mr.assignee?.name ?? null,
        metadata: mr as unknown as Record<string, unknown>,
      },
    };
  }
}
