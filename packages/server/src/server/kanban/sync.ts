import type pino from "pino";
import type {
  KanbanCardSource,
  KanbanExternalStatus,
  KanbanPriority,
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
    // statusCategory.key is Jira's stable 3-bucket classification ("new" |
    // "indeterminate" | "done"), always nested in the status object Jira
    // returns — no extra `fields` param needed to fetch it.
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: { displayName?: string } | null;
    labels?: string[];
    priority?: { name?: string } | null;
    // Jira's own timestamps (ISO). Fetched explicitly on Cloud (see the fields
    // param); returned by default on Server/DC.
    created?: string;
    updated?: string;
    [key: string]: unknown;
  };
}

// Jira's priority names ("Highest" | "High" | "Medium" | "Low" | "Lowest" on
// the default scheme) collapse onto Paseo's 3-value KanbanPriority. Unknown
// or custom priority names (e.g. a self-hosted custom scheme) map to null
// rather than guessing.
const JIRA_PRIORITY_MAP: Record<string, KanbanPriority> = {
  highest: "high",
  high: "high",
  medium: "med",
  low: "low",
  lowest: "low",
};

function mapJiraPriority(name: string | undefined): KanbanPriority | null {
  if (!name) {
    return null;
  }
  return JIRA_PRIORITY_MAP[name.toLowerCase()] ?? null;
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  // Cloud enhanced-JQL pagination (rest/api/3/search/jql).
  nextPageToken?: string;
  isLast?: boolean;
  // Server/DC classic pagination (rest/api/2/search).
  startAt?: number;
  total?: number;
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
  // ISO timestamps GitLab returns on the MR list endpoint.
  created_at?: string;
  updated_at?: string;
  // False when the MR has open blocking discussion threads. Present on the MR
  // list endpoint, so detecting unresolved threads costs no extra request.
  blocking_discussions_resolved?: boolean;
}

// GitLab MR list responses don't carry one canonical "status" field the way
// Jira does — derive an override-table key from state/draft/pipeline instead.
// Used only as the lookup key for source.columnMap/statusMap overrides.
function gitlabExternalStatusKey(mr: GitlabMergeRequest): string {
  if (mr.state === "merged") return "merged";
  if (mr.state === "closed") return "closed";
  if (mr.head_pipeline?.status === "failed") return "pipeline_failed";
  if (mr.draft || mr.work_in_progress) return "opened_draft";
  return "opened";
}

// Jira's 3-value statusCategory bucket, mapped to the matching default
// column's legacyStatus. Unknown/missing category falls back to "pending"
// ("new"), the least surprising default for a status Paseo hasn't seen.
function jiraCategoryLegacyStatus(categoryKey: string | undefined): KanbanStatus {
  if (categoryKey === "done") return "done";
  if (categoryKey === "indeterminate") return "wip";
  return "pending";
}

// GitLab MRs only ever have two board-relevant buckets: still open (including
// draft) is in progress, merged or closed is done.
function gitlabCategoryLegacyStatus(mr: GitlabMergeRequest): KanbanStatus {
  return mr.state === "merged" || mr.state === "closed" ? "done" : "wip";
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// GitLab MR state has a fixed, small vocabulary — no API call needed to list it.
const GITLAB_EXTERNAL_STATUSES: KanbanExternalStatus[] = [
  { name: "opened", category: "opened" },
  { name: "merged", category: "merged" },
  { name: "closed", category: "closed" },
];

// Jira status entry as returned by both endpoints listExternalStatuses uses:
// GET /rest/api/3/status (flat array) and GET /rest/api/3/project/{key}/statuses
// (array grouped by issue type, each with its own `statuses` array).
interface JiraStatusEntry {
  name?: string;
  statusCategory?: { key?: string };
  statuses?: JiraStatusEntry[];
}

function parseJiraStatusesResponse(body: unknown): KanbanExternalStatus[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const flat: JiraStatusEntry[] = [];
  for (const entry of body as JiraStatusEntry[]) {
    if (Array.isArray(entry.statuses)) {
      flat.push(...entry.statuses);
    } else {
      flat.push(entry);
    }
  }
  const byName = new Map<string, KanbanExternalStatus>();
  for (const entry of flat) {
    if (typeof entry.name === "string" && !byName.has(entry.name)) {
      byName.set(entry.name, { name: entry.name, category: entry.statusCategory?.key ?? null });
    }
  }
  return [...byName.values()];
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
  onCardCreated?: (card: StoredKanbanCard, source: StoredKanbanSource) => Promise<void>;
}

// An access token is refreshed once it's within this window of expiring,
// rather than waiting for the provider to reject an already-stale request.
const TOKEN_REFRESH_SKEW_MS = 60_000;

// Safety cap on pagination loops (Jira and GitLab) so a runaway JQL/filter
// can't make a single sync fetch unbounded pages. 20 pages * 100 per page.
const MAX_SYNC_PAGES = 20;
const SYNC_PAGE_SIZE = 100;

export class KanbanSyncService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;
  private readonly onCardCreated?: (
    card: StoredKanbanCard,
    source: StoredKanbanSource,
  ) => Promise<void>;

  constructor(options: KanbanSyncServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
    this.onCardCreated = options.onCardCreated;
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
      const cards: StoredKanbanCard[] = [];
      if (source.kind === "jira") {
        const issues = await this.fetchJiraIssues(
          baseUrl,
          source.query,
          token,
          connection?.email ?? null,
        );
        for (const issue of issues) {
          const { cardSource, payload } = await this.buildJiraUpsert(baseUrl, source, issue);
          const card = await this.store.upsertCardBySource(cardSource, payload);
          cards.push(card);
          if (card.created) {
            await this.onCardCreated?.(card, source);
          }
        }
      } else {
        const seenExternalIds = new Set<string>();
        const mergeRequests = await this.fetchGitlabMergeRequests(baseUrl, source.query, token);
        for (const mr of mergeRequests) {
          const { cardSource, payload } = await this.buildGitlabUpsert(baseUrl, source, mr);
          seenExternalIds.add(cardSource.externalId);
          const card = await this.store.upsertCardBySource(cardSource, payload);
          cards.push(card);
          if (card.created) {
            await this.onCardCreated?.(card, source);
          }
        }
        cards.push(
          ...(await this.reconcileTerminalGitlabCards(baseUrl, source, token, seenExternalIds)),
        );
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

  // Jira Cloud REST auth is HTTP Basic base64(email:apiToken). Jira Server/DC
  // Personal Access Tokens use Bearer, so fall back to Bearer without an email.
  private jiraAuthHeaders(token: string | null, email: string | null): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers.Authorization = email
        ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
        : `Bearer ${token}`;
    }
    return headers;
  }

  // Live-fetches the external tracker's status list for a column-mapping UI
  // (not the cached statusMap/columnMap override tables). GitLab's vocabulary
  // is fixed and returned without a request; Jira queries either a project's
  // workflow statuses (projectKey given) or the whole instance's status list.
  async listExternalStatuses(
    source: StoredKanbanSource,
    projectKey?: string,
  ): Promise<KanbanExternalStatus[]> {
    if (source.kind === "gitlab") {
      return GITLAB_EXTERNAL_STATUSES;
    }
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
    const headers = this.jiraAuthHeaders(token, connection?.email ?? null);
    const base = trimTrailingSlash(baseUrl);
    const url = projectKey
      ? `${base}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`
      : `${base}/rest/api/3/status`;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`Jira status list request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as unknown;
    return parseJiraStatusesResponse(body);
  }

  private async fetchJiraIssues(
    baseUrl: string,
    query: string,
    token: string | null,
    email: string | null,
  ): Promise<JiraIssue[]> {
    const base = trimTrailingSlash(baseUrl);
    const headers = this.jiraAuthHeaders(token, email);
    // An email means Jira Cloud (HTTP Basic auth). Jira Cloud removed the old
    // GET /rest/api/2/search (returns 410 Gone) in favour of the enhanced-JQL
    // /rest/api/3/search/jql, which returns only id/key unless `fields` is given.
    // Jira Server/DC (Bearer PAT, no email) still uses /rest/api/2/search.
    return email
      ? this.fetchJiraCloudIssues(base, query, headers)
      : this.fetchJiraServerIssues(base, query, headers);
  }

  // Cloud enhanced-JQL search pages via an opaque nextPageToken rather than
  // startAt/total, so it has to be threaded through from the previous response.
  private async fetchJiraCloudIssues(
    base: string,
    query: string,
    headers: Record<string, string>,
  ): Promise<JiraIssue[]> {
    const jql = encodeURIComponent(query);
    const fields = encodeURIComponent("summary,status,assignee,labels,priority,created,updated");
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      const pageTokenParam = nextPageToken
        ? `&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : "";
      const url = `${base}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=${SYNC_PAGE_SIZE}${pageTokenParam}`;
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`Jira sync request failed: ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as JiraSearchResponse;
      issues.push(...(body.issues ?? []));
      if (!body.nextPageToken || body.isLast) {
        break;
      }
      nextPageToken = body.nextPageToken;
    }
    return issues;
  }

  private async fetchJiraServerIssues(
    base: string,
    query: string,
    headers: Record<string, string>,
  ): Promise<JiraIssue[]> {
    const jql = encodeURIComponent(query);
    const issues: JiraIssue[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      const url = `${base}/rest/api/2/search?jql=${jql}&maxResults=${SYNC_PAGE_SIZE}&startAt=${startAt}`;
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`Jira sync request failed: ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as JiraSearchResponse;
      const pageIssues = body.issues ?? [];
      issues.push(...pageIssues);
      startAt += pageIssues.length;
      const reachedTotal = body.total !== undefined && startAt >= body.total;
      if (pageIssues.length < SYNC_PAGE_SIZE || reachedTotal) {
        break;
      }
    }
    return issues;
  }

  private async fetchGitlabMergeRequests(
    baseUrl: string,
    query: string,
    token: string | null,
  ): Promise<GitlabMergeRequest[]> {
    const base = trimTrailingSlash(baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const params = new URLSearchParams(query);
    const perPage = Number(params.get("per_page")) || SYNC_PAGE_SIZE;
    params.set("per_page", String(perPage));
    const mergeRequests: GitlabMergeRequest[] = [];
    for (let page = 1; page <= MAX_SYNC_PAGES; page++) {
      params.set("page", String(page));
      const url = `${base}/api/v4/merge_requests?${params.toString()}`;
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`GitLab sync request failed: ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as GitlabMergeRequest[];
      mergeRequests.push(...(body ?? []));
      if (!body || body.length < perPage) {
        break;
      }
    }
    return mergeRequests;
  }

  private async buildJiraUpsert(
    baseUrl: string,
    source: StoredKanbanSource,
    issue: JiraIssue,
  ): Promise<{
    cardSource: Extract<KanbanCardSource, { kind: "jira" }>;
    payload: UpsertKanbanCardBySourcePayload;
  }> {
    const externalId = `jira:${issue.key}`;
    const fields = issue.fields ?? {};
    const externalStatus = fields.status?.name ?? "";
    const column = await this.store.resolveColumnForSync({
      columnIdOverride: source.columnMap?.[externalStatus],
      legacyStatusOverride: source.statusMap?.[externalStatus],
      categoryLegacyStatus: jiraCategoryLegacyStatus(fields.status?.statusCategory?.key),
    });
    return {
      cardSource: {
        kind: "jira",
        externalId,
        project: issue.key.split("-")[0],
        issueKey: issue.key,
      },
      payload: {
        title: fields.summary ?? issue.key,
        url: `${trimTrailingSlash(baseUrl)}/browse/${issue.key}`,
        status: column.legacyStatus,
        columnId: column.id,
        theme: "jira",
        labels: fields.labels,
        assignee: fields.assignee?.displayName ?? null,
        priority: mapJiraPriority(fields.priority?.name),
        metadata: issue.fields as Record<string, unknown> | undefined,
        sourceCreatedAt: fields.created ?? null,
        sourceUpdatedAt: fields.updated ?? null,
      },
    };
  }

  private async buildGitlabUpsert(
    baseUrl: string,
    source: StoredKanbanSource,
    mr: GitlabMergeRequest,
  ): Promise<{
    cardSource: Extract<KanbanCardSource, { kind: "gitlab" }>;
    payload: UpsertKanbanCardBySourcePayload;
  }> {
    const projectId = String(mr.project_id);
    const mrIid = String(mr.iid);
    const externalId = `gitlab:${projectId}!${mrIid}`;
    const externalStatusKey = gitlabExternalStatusKey(mr);
    const column = await this.store.resolveColumnForSync({
      columnIdOverride: source.columnMap?.[externalStatusKey],
      legacyStatusOverride: source.statusMap?.[externalStatusKey],
      categoryLegacyStatus: gitlabCategoryLegacyStatus(mr),
    });
    // A merged/closed MR is terminal — force it into its resolved column even
    // if the user previously dragged the card elsewhere.
    const isTerminal = mr.state === "merged" || mr.state === "closed";
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
        status: column.legacyStatus,
        columnId: column.id,
        theme: "gitlab-mr",
        labels: mr.labels,
        assignee: mr.assignee?.name ?? null,
        metadata: mr as unknown as Record<string, unknown>,
        sourceCreatedAt: mr.created_at ?? null,
        sourceUpdatedAt: mr.updated_at ?? null,
        hasUnresolvedThreads: mr.blocking_discussions_resolved === false,
        forceStatus: isTerminal,
      },
    };
  }

  // A merged/closed MR drops out of a state-filtered sync query (the common
  // `state=opened` filter), so the sync loop above never sees it again and the
  // forceStatus→Done move never fires — the card is stuck in whatever column it
  // held when it last matched the query. This pass re-checks each
  // previously-synced GitLab card the query omitted: it hits the single-MR
  // endpoint and, only when the MR is now terminal, runs it through the same
  // upsert so the merged/closed → Done move finally happens. Cards whose stored
  // metadata is already terminal are skipped, so each MR costs exactly one
  // extra request — the sync that moves it. Cards belonging to a different
  // GitLab source/instance return 404/401 under this token and are ignored.
  private async reconcileTerminalGitlabCards(
    baseUrl: string,
    source: StoredKanbanSource,
    token: string | null,
    seenExternalIds: Set<string>,
  ): Promise<StoredKanbanCard[]> {
    const moved: StoredKanbanCard[] = [];
    for (const card of await this.store.listCards()) {
      if (card.source.kind !== "gitlab" || seenExternalIds.has(card.externalId ?? "")) {
        continue;
      }
      const storedState = (card.metadata as { state?: string } | undefined)?.state;
      if (storedState === "merged" || storedState === "closed") {
        continue;
      }
      // Best-effort per card: a network error re-fetching one card must not
      // fail the whole sync, whose primary query already succeeded.
      try {
        const mr = await this.fetchGitlabMergeRequestById(
          baseUrl,
          card.source.projectId,
          card.source.mrIid,
          token,
        );
        if (!mr || (mr.state !== "merged" && mr.state !== "closed")) {
          continue;
        }
        const { cardSource, payload } = await this.buildGitlabUpsert(baseUrl, source, mr);
        moved.push(await this.store.upsertCardBySource(cardSource, payload));
      } catch (error) {
        this.logger?.warn(
          { err: error, sourceId: source.id, externalId: card.externalId },
          "Kanban terminal-state reconciliation failed for card",
        );
      }
    }
    return moved;
  }

  private async fetchGitlabMergeRequestById(
    baseUrl: string,
    projectId: string,
    mrIid: string,
    token: string | null,
  ): Promise<GitlabMergeRequest | null> {
    const base = trimTrailingSlash(baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const url = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}`;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      // 404/401 → the card belongs to a different GitLab source/instance, or the
      // MR was deleted. Not this sync's problem; leave the card untouched.
      return null;
    }
    return (await response.json()) as GitlabMergeRequest;
  }
}
