import type pino from "pino";
import type {
  KanbanCardSource,
  KanbanExternalStatus,
  KanbanPriority,
  KanbanStatus,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore, type UpsertKanbanCardBySourcePayload } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { jiraAuthHeaders, resolveKanbanToken, trimTrailingSlash } from "./credentials.js";

interface JiraAssignee {
  displayName?: string;
  accountId?: string;
  name?: string;
  key?: string;
}

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    // statusCategory.key is Jira's stable 3-bucket classification ("new" |
    // "indeterminate" | "done"), always nested in the status object Jira
    // returns — no extra `fields` param needed to fetch it.
    status?: { name?: string; statusCategory?: { key?: string } };
    // accountId (Cloud) / name / key (Server/DC) identify WHO the issue is
    // assigned to, so the reconcile pass can tell "reassigned to someone else"
    // (drop the card) apart from "still mine, just dropped out of the query"
    // (keep it, flagged detached). displayName is the label the board shows.
    assignee?: JiraAssignee | null;
    labels?: string[];
    priority?: { name?: string } | null;
    // Jira's own timestamps (ISO). Fetched explicitly on Cloud (see the fields
    // param); returned by default on Server/DC.
    created?: string;
    updated?: string;
    // Issue type (Bug/Story/Task/...) — icon + name for the app's future type
    // glyph. Fetched explicitly on Cloud (see the fields param); returned by
    // default on Server/DC. Epic-specific customfields are deliberately not
    // captured here (unstable field IDs per Jira instance).
    issuetype?: { name?: string; iconUrl?: string };
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

// The authenticated user's own identity, from GET /myself. Cloud returns an
// accountId; Server/DC return name/key. Used to decide whether a card that
// dropped out of an `assignee = currentUser()` query was reassigned to someone
// else (drop it) or just changed status while still assigned to the user.
interface JiraSelf {
  accountId?: string;
  name?: string;
  key?: string;
}

// True only when the issue is assigned to a DIFFERENT user than `me`. Compares
// on whichever identity field both sides carry (accountId on Cloud, name/key on
// Server/DC). Deliberately conservative: an unassigned issue, an unknown self
// (the /myself lookup failed), or no comparable identity all return false, so a
// card is only ever dropped on a positive "assigned to someone else" match.
function jiraAssigneeIsSomeoneElse(
  assignee: JiraAssignee | null | undefined,
  me: JiraSelf | null,
): boolean {
  if (!assignee || !me) {
    return false;
  }
  if (assignee.accountId && me.accountId) {
    return assignee.accountId !== me.accountId;
  }
  if (assignee.name && me.name) {
    return assignee.name !== me.name;
  }
  if (assignee.key && me.key) {
    return assignee.key !== me.key;
  }
  return false;
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
  // The MR's current reviewers. Returned by the single-MR endpoint (not the
  // list endpoint), so the reconcile pass uses it to tell "still awaiting my
  // review" from "I was removed as reviewer". Absent → identity unknown, treat
  // as still-a-reviewer (conservative, never drops on missing data).
  reviewers?: { username?: string; id?: number }[];
  head_pipeline?: { status?: string } | null;
  // ISO timestamps GitLab returns on the MR list endpoint.
  created_at?: string;
  updated_at?: string;
  // False when the MR has open blocking discussion threads. Present on the MR
  // list endpoint, so detecting unresolved threads costs no extra request.
  blocking_discussions_resolved?: boolean;
}

// The reviewer this GitLab board tracks, read straight from the source query
// (`...&reviewer_username=alice`). The board is a filtered review queue, so the
// query itself names whose queue it is — more accurate than GET /user, which
// would report the token's own account (not necessarily the tracked reviewer).
// Null when the query has no reviewer_username filter (e.g. a plain state query
// or an assignee/reviewer_id filter), in which case reviewer-removal can't be
// judged and such cards are kept rather than dropped.
function parseGitlabReviewerUsername(query: string): string | null {
  const username = new URLSearchParams(query).get("reviewer_username");
  return username && username.length > 0 ? username : null;
}

// True only when the MR is open AND we can prove the tracked reviewer is no
// longer on it. Conservative: unknown reviewer, a non-open MR, or a missing
// reviewers array all return false, so a card is only ever dropped on a proven
// "removed as reviewer". Usernames compare case-insensitively (GitLab usernames
// are case-insensitive).
function gitlabReviewerRemoved(mr: GitlabMergeRequest, reviewerUsername: string | null): boolean {
  if (!reviewerUsername || mr.state !== "opened" || !Array.isArray(mr.reviewers)) {
    return false;
  }
  const wanted = reviewerUsername.toLowerCase();
  return !mr.reviewers.some((reviewer) => reviewer.username?.toLowerCase() === wanted);
}

// GitLab's approvals endpoint — the list endpoint never returns approval
// state (CE and EE alike), so "has this MR collected its required approvals"
// needs its own request per open MR (see fetchGitlabApprovalState below).
interface GitlabApprovalState {
  approved: boolean;
  approvalsLeft: number;
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
export function jiraCategoryLegacyStatus(categoryKey: string | undefined): KanbanStatus {
  if (categoryKey === "done") return "done";
  if (categoryKey === "indeterminate") return "wip";
  return "pending";
}

// The statusCategory key off a card's stored Jira metadata blob (sync writes
// `issue.fields` there verbatim), used to skip re-fetching a card whose status
// is already terminal. Undefined for a card synced before metadata existed.
function jiraStoredCategoryKey(card: StoredKanbanCard): string | undefined {
  const status = (card.metadata as { status?: { statusCategory?: { key?: string } } } | undefined)
    ?.status;
  return status?.statusCategory?.key;
}

// GitLab MRs only ever have two board-relevant buckets: still open (including
// draft) is in progress, merged or closed is done.
function gitlabCategoryLegacyStatus(mr: GitlabMergeRequest): KanbanStatus {
  return mr.state === "merged" || mr.state === "closed" ? "done" : "wip";
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
  id?: string;
  name?: string;
  statusCategory?: { key?: string };
  statuses?: JiraStatusEntry[];
}

/**
 * A parsed Jira status with its Jira-internal id kept alongside the wire
 * fields. The id never leaves the daemon — source-statuses.ts uses it to
 * match the agile board's columnConfig (which references statuses by id) and
 * strips it before returning KanbanExternalStatus over the RPC.
 */
export interface ParsedJiraStatus extends KanbanExternalStatus {
  id?: string;
}

export function parseJiraStatusesResponse(body: unknown): ParsedJiraStatus[] {
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
  const byName = new Map<string, ParsedJiraStatus>();
  for (const entry of flat) {
    if (typeof entry.name === "string" && !byName.has(entry.name)) {
      byName.set(entry.name, {
        name: entry.name,
        category: entry.statusCategory?.key ?? null,
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      });
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

// Safety cap on pagination loops (Jira and GitLab) so a runaway JQL/filter
// can't make a single sync fetch unbounded pages. 20 pages * 100 per page.
const MAX_SYNC_PAGES = 20;
const SYNC_PAGE_SIZE = 100;

// Per-round cap on single-card re-fetches in the detached-card reconcile pass.
// Steady state is 0-2 cards; the cap only bites when a query edit drops a large
// batch out at once, and the remainder simply reconciles on later rounds.
const MAX_RECONCILE_CARDS = 25;

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

      const token = await resolveKanbanToken({
        source,
        connection,
        secrets: this.secrets,
        oauthService: this.oauthService,
      });
      const { cards, truncated } =
        source.kind === "jira"
          ? await this.syncJiraCards(baseUrl, source, token, connection?.email ?? null)
          : await this.syncGitlabCards(baseUrl, source, token);
      return await this.recordSyncSuccess(source, cards, truncated);
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

  private async syncJiraCards(
    baseUrl: string,
    source: StoredKanbanSource,
    token: string | null,
    email: string | null,
  ): Promise<{ cards: StoredKanbanCard[]; truncated: boolean }> {
    const seenExternalIds = new Set<string>();
    const { issues, truncated } = await this.fetchJiraIssues(baseUrl, source.query, token, email);
    const cards: StoredKanbanCard[] = [];
    for (const issue of issues) {
      const { cardSource, payload } = await this.buildJiraUpsert(baseUrl, source, issue);
      seenExternalIds.add(cardSource.externalId);
      const card = await this.store.upsertCardBySource(cardSource, payload);
      cards.push(card);
      if (card.created) {
        await this.onCardCreated?.(card, source);
      }
    }
    cards.push(
      ...(await this.reconcileDetachedJiraCards(
        baseUrl,
        source,
        token,
        email,
        seenExternalIds,
        truncated,
      )),
    );
    return { cards, truncated };
  }

  private async syncGitlabCards(
    baseUrl: string,
    source: StoredKanbanSource,
    token: string | null,
  ): Promise<{ cards: StoredKanbanCard[]; truncated: boolean }> {
    const seenExternalIds = new Set<string>();
    const { mergeRequests, truncated } = await this.fetchGitlabMergeRequests(
      baseUrl,
      source.query,
      token,
    );
    const cards: StoredKanbanCard[] = [];
    for (const mr of mergeRequests) {
      // Only still-open MRs need an approvals lookup — merged/closed ones are
      // terminal and the stats bar's "pending review" backlog only counts
      // what's still awaiting approval right now.
      const approvals =
        mr.state === "opened"
          ? await this.fetchGitlabApprovalState(baseUrl, mr.project_id, mr.iid, token)
          : null;
      const { cardSource, payload } = await this.buildGitlabUpsert(baseUrl, source, mr, approvals);
      seenExternalIds.add(cardSource.externalId);
      const card = await this.store.upsertCardBySource(cardSource, payload);
      cards.push(card);
      if (card.created) {
        await this.onCardCreated?.(card, source);
      }
    }
    cards.push(
      ...(await this.reconcileDetachedGitlabCards(
        baseUrl,
        source,
        token,
        seenExternalIds,
        truncated,
      )),
    );
    return { cards, truncated };
  }

  // A truncated page walk isn't a hard failure (the cards it did fetch are
  // valid), but silently dropping the tail of a runaway query is worse than
  // surfacing it — record a warning on the same lastSyncError channel a real
  // sync failure uses, so the source's sync-status row shows it.
  private async recordSyncSuccess(
    source: StoredKanbanSource,
    cards: StoredKanbanCard[],
    truncated: boolean,
  ): Promise<KanbanSyncResult> {
    const truncationWarning = truncated
      ? `Sync hit the ${MAX_SYNC_PAGES * SYNC_PAGE_SIZE}-item page cap — some cards may be missing. Narrow the query to see everything.`
      : null;
    if (truncationWarning) {
      this.logger?.warn(
        { sourceId: source.id, cap: MAX_SYNC_PAGES * SYNC_PAGE_SIZE },
        "Kanban sync hit its pagination cap; results may be incomplete",
      );
    }
    const updatedSource = await this.store.recordSourceSync(source.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncError: truncationWarning,
    });
    return { source: updatedSource, cards, error: truncationWarning };
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
    const token = await resolveKanbanToken({
      source,
      connection,
      secrets: this.secrets,
      oauthService: this.oauthService,
    });
    const headers = jiraAuthHeaders(token, connection?.email ?? null);
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
  ): Promise<{ issues: JiraIssue[]; truncated: boolean }> {
    const base = trimTrailingSlash(baseUrl);
    const headers = jiraAuthHeaders(token, email);
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
  ): Promise<{ issues: JiraIssue[]; truncated: boolean }> {
    const jql = encodeURIComponent(query);
    const fields = encodeURIComponent(
      "summary,status,assignee,labels,priority,created,updated,issuetype",
    );
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let truncated = false;
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
      if (page === MAX_SYNC_PAGES - 1) {
        // Hit the safety cap with more pages still pending — the walk stops
        // here, not because the query naturally ended.
        truncated = true;
      }
    }
    return { issues, truncated };
  }

  private async fetchJiraServerIssues(
    base: string,
    query: string,
    headers: Record<string, string>,
  ): Promise<{ issues: JiraIssue[]; truncated: boolean }> {
    const jql = encodeURIComponent(query);
    const issues: JiraIssue[] = [];
    let startAt = 0;
    let truncated = false;
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
      if (page === MAX_SYNC_PAGES - 1) {
        truncated = true;
      }
    }
    return { issues, truncated };
  }

  // Single-issue lookup for the reconcile pass. Same Cloud/Server split the
  // search endpoints use (an email means Cloud). A 404/403 means deleted or
  // no longer visible to this token — reported as null, not thrown, since the
  // caller treats it as "detached", not as a sync failure.
  private async fetchJiraIssueByKey(
    baseUrl: string,
    issueKey: string,
    token: string | null,
    email: string | null,
  ): Promise<JiraIssue | null> {
    const base = trimTrailingSlash(baseUrl);
    const headers = jiraAuthHeaders(token, email);
    const apiVersion = email ? "3" : "2";
    const fields = encodeURIComponent(
      "summary,status,assignee,labels,priority,created,updated,issuetype",
    );
    const url = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;
    const response = await this.fetchImpl(url, { headers });
    if (response.status === 404 || response.status === 403) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Jira issue request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as JiraIssue;
  }

  // The authenticated user's identity, for the reconcile pass to tell a
  // reassigned-away issue apart from one still assigned to the user. Same
  // Cloud/Server split (an email means Cloud). Best-effort: any failure returns
  // null, and the caller then keeps the card (flagged detached) rather than
  // risk dropping a card it can't prove was reassigned.
  private async fetchJiraMyself(
    baseUrl: string,
    token: string | null,
    email: string | null,
  ): Promise<JiraSelf | null> {
    const base = trimTrailingSlash(baseUrl);
    const headers = jiraAuthHeaders(token, email);
    const apiVersion = email ? "3" : "2";
    const url = `${base}/rest/api/${apiVersion}/myself`;
    try {
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as JiraSelf;
      return {
        accountId: body.accountId,
        name: body.name,
        key: body.key,
      };
    } catch (error) {
      this.logger?.warn({ err: error }, "Kanban Jira /myself lookup failed");
      return null;
    }
  }

  private async fetchGitlabMergeRequests(
    baseUrl: string,
    query: string,
    token: string | null,
  ): Promise<{ mergeRequests: GitlabMergeRequest[]; truncated: boolean }> {
    const base = trimTrailingSlash(baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const params = new URLSearchParams(query);
    const perPage = Number(params.get("per_page")) || SYNC_PAGE_SIZE;
    params.set("per_page", String(perPage));
    const mergeRequests: GitlabMergeRequest[] = [];
    let truncated = false;
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
      if (page === MAX_SYNC_PAGES) {
        truncated = true;
      }
    }
    return { mergeRequests, truncated };
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
        sourceId: source.id,
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
    approvals: GitlabApprovalState | null,
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
        sourceId: source.id,
        theme: "gitlab-mr",
        labels: mr.labels,
        assignee: mr.assignee?.name ?? null,
        // Spread first so the raw MR object's own keys (merged_at, closed_at,
        // detailed_merge_status, etc. — the API returns more than the
        // GitlabMergeRequest interface declares, and it all rides along
        // as-is) still win over nothing; `approvals` is the one field the
        // list endpoint never includes at any GitLab edition, so it's merged
        // in on top instead of coming from `mr` itself.
        metadata: {
          ...(mr as unknown as Record<string, unknown>),
          approvals,
        },
        sourceCreatedAt: mr.created_at ?? null,
        sourceUpdatedAt: mr.updated_at ?? null,
        hasUnresolvedThreads: mr.blocking_discussions_resolved === false,
        forceStatus: isTerminal,
      },
    };
  }

  // Cards the primary query didn't return this round, and that this source is
  // responsible for. Two very different reasons a card can be missing:
  //
  //   1. It genuinely no longer matches the query (issue reassigned, MR
  //      merged out of a `state=opened` filter) — this pass's job.
  //   2. The page walk stopped early at MAX_SYNC_PAGES, so the card may well
  //      still match and simply wasn't fetched.
  //
  // Telling those apart is impossible from here, so a truncated walk skips
  // reconciliation entirely rather than mass-flagging healthy cards as
  // detached. Ownership is by sourceId: a card another source synced is never
  // touched. Cards predating sourceId (undefined) are still re-fetched — that
  // backfills the field — but are never flagged as detached on a failed
  // lookup, since a 404 there is more likely "belongs to another instance"
  // than "gone".
  private async detachmentCandidates(
    source: StoredKanbanSource,
    seenExternalIds: Set<string>,
    truncated: boolean,
  ): Promise<StoredKanbanCard[]> {
    if (truncated) {
      this.logger?.warn(
        { sourceId: source.id },
        "Kanban sync hit the page cap — skipping detached-card reconciliation this round",
      );
      return [];
    }
    const candidates = (await this.store.listCards()).filter(
      (card) =>
        card.source.kind === source.kind &&
        !seenExternalIds.has(card.externalId ?? "") &&
        (card.sourceId === source.id || card.sourceId === undefined),
    );
    if (candidates.length <= MAX_RECONCILE_CARDS) {
      return candidates;
    }
    // A query edit can drop hundreds of cards out at once. Re-fetching them all
    // in one round would be a request storm against the tracker, so this round
    // handles a slice and the rest follow on later rounds — logged, never
    // silently dropped.
    this.logger?.warn(
      { sourceId: source.id, candidates: candidates.length, cap: MAX_RECONCILE_CARDS },
      "Kanban detached-card reconciliation capped — remaining cards retry next sync",
    );
    return candidates.slice(0, MAX_RECONCILE_CARDS);
  }

  // The tracker no longer serves this card's issue/MR (404, or no longer
  // visible to this token). It isn't coming back through the query either, so
  // flag it and keep the last known status — there is nothing better to show.
  // Cards with no sourceId are left alone: a failed lookup there more likely
  // means the card belongs to a different instance than that it is gone.
  private async flagUnreachableCard(
    card: StoredKanbanCard,
    source: StoredKanbanSource,
  ): Promise<StoredKanbanCard | null> {
    if (card.sourceId !== source.id) {
      return null;
    }
    return this.store.setCardDetached(card.id, true);
  }

  // A Jira issue that drops out of an `assignee = currentUser()` query is
  // handled by outcome:
  //
  //   - Reassigned to someone else → the card is removed from the board. It is
  //     no longer the user's work, so keeping a stale copy only clutters it.
  //   - Still assigned to the user (or unassigned), just no longer matching the
  //     query (e.g. its status changed) → the card is kept, its real current
  //     status written back, and flagged detached so the board shows it no
  //     longer matches. Without this the card freezes at whatever status it
  //     last held — showing "Backlog" for an issue that has since been closed.
  //
  // "Unassigned" deliberately does NOT count as reassigned-away: an issue with
  // no assignee is not someone else's work, so the card is kept (flagged), not
  // dropped. Removal only fires on a positive "assigned to a different user"
  // match, and never when the /myself lookup failed (self unknown).
  private async reconcileDetachedJiraCards(
    baseUrl: string,
    source: StoredKanbanSource,
    token: string | null,
    email: string | null,
    seenExternalIds: Set<string>,
    truncated: boolean,
  ): Promise<StoredKanbanCard[]> {
    const candidates = (await this.detachmentCandidates(source, seenExternalIds, truncated)).filter(
      (card) => card.source.kind === "jira",
    );
    if (candidates.length === 0) {
      return [];
    }
    // One /myself lookup per round covers every candidate. Null on failure —
    // the reassignment check then never fires, so a card is only ever kept.
    const me = await this.fetchJiraMyself(baseUrl, token, email);
    const reconciled: StoredKanbanCard[] = [];
    for (const card of candidates) {
      if (card.source.kind !== "jira") {
        continue;
      }
      // Already flagged and already terminal — its status can't drift further,
      // so re-fetching it every 210s forever would be pure waste.
      if (card.detachedFromSource && jiraStoredCategoryKey(card) === "done") {
        continue;
      }
      // Best-effort per card: one card's network error must not fail a sync
      // whose primary query already succeeded.
      try {
        const issue = await this.fetchJiraIssueByKey(baseUrl, card.source.issueKey, token, email);
        if (!issue) {
          // A 404 here is an expected outcome, not a sync error.
          const flagged = await this.flagUnreachableCard(card, source);
          if (flagged) {
            reconciled.push(flagged);
          }
          continue;
        }
        // Reassigned to another user — this card is no longer the user's work.
        // Drop it (only for cards this source owns, mirroring flagUnreachableCard).
        if (jiraAssigneeIsSomeoneElse(issue.fields?.assignee, me)) {
          if (card.sourceId === source.id) {
            await this.store.deleteCard(card.id);
          }
          continue;
        }
        const { cardSource, payload } = await this.buildJiraUpsert(baseUrl, source, issue);
        reconciled.push(
          await this.store.upsertCardBySource(cardSource, {
            ...payload,
            detachedFromSource: true,
            // A closed issue is terminal — it belongs in done even if the user
            // once dragged the card elsewhere, same rule a merged MR follows.
            forceStatus:
              jiraCategoryLegacyStatus(issue.fields?.status?.statusCategory?.key) === "done",
          }),
        );
      } catch (error) {
        this.logger?.warn(
          { err: error, sourceId: source.id, externalId: card.externalId },
          "Kanban detached-card reconciliation failed for card",
        );
      }
    }
    return reconciled;
  }

  // A merged/closed MR drops out of a state-filtered sync query (the common
  // `state=opened&reviewer_username=...` filter). Handled by outcome:
  //
  //   - Closed (not merged) → removed. A closed MR is abandoned work, not the
  //     user's review anymore, so keeping a stale card only clutters the queue.
  //   - Still open but the tracked reviewer was removed → removed. No longer the
  //     user's review either (the GitLab analogue of a reassigned Jira issue).
  //   - Merged → kept, moved to Done, flagged detached. A merged MR IS terminal
  //     and the GitLab board hides merged cards from its lanes (see
  //     kanban-gitlab-board), but the card stays in the store so the stats strip
  //     (merged-in-7d/30d, avg time-to-merge) can still count it.
  //   - Still open and still the user's to review (or the reviewer can't be
  //     determined) — dropped out for some other reason → kept, real state
  //     written back, flagged detached.
  //
  // Conservative by construction: removal only fires on a proven closed state or
  // a proven reviewer removal (see gitlabReviewerRemoved), never on missing
  // data, never during a truncated page walk (candidates are empty then), and
  // only for cards this source owns.
  private async reconcileDetachedGitlabCards(
    baseUrl: string,
    source: StoredKanbanSource,
    token: string | null,
    seenExternalIds: Set<string>,
    truncated: boolean,
  ): Promise<StoredKanbanCard[]> {
    const reviewerUsername = parseGitlabReviewerUsername(source.query);
    const reconciled: StoredKanbanCard[] = [];
    for (const card of await this.detachmentCandidates(source, seenExternalIds, truncated)) {
      if (card.source.kind !== "gitlab") {
        continue;
      }
      // Already flagged and already merged — its state can't drift further, and
      // it is only kept for the stats strip, so re-fetching it forever is waste.
      const storedState = (card.metadata as { state?: string } | undefined)?.state;
      if (card.detachedFromSource && storedState === "merged") {
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
        if (!mr) {
          // A 404 here is an expected outcome, not a sync error.
          const flagged = await this.flagUnreachableCard(card, source);
          if (flagged) {
            reconciled.push(flagged);
          }
          continue;
        }
        // Closed, or no longer the user's to review — drop it (only for cards
        // this source owns, mirroring flagUnreachableCard). Merged is NOT dropped
        // here: it is kept for the stats strip and hidden at the render layer.
        if (mr.state === "closed" || gitlabReviewerRemoved(mr, reviewerUsername)) {
          if (card.sourceId === source.id) {
            await this.store.deleteCard(card.id);
          }
          continue;
        }
        // Merged → Done + detached; still-open-still-mine → detached in place.
        // approvals isn't worth a second request for a card in this state.
        const { cardSource, payload } = await this.buildGitlabUpsert(baseUrl, source, mr, null);
        reconciled.push(
          await this.store.upsertCardBySource(cardSource, {
            ...payload,
            detachedFromSource: true,
            forceStatus: mr.state === "merged",
          }),
        );
      } catch (error) {
        this.logger?.warn(
          { err: error, sourceId: source.id, externalId: card.externalId },
          "Kanban detached-card reconciliation failed for card",
        );
      }
    }
    return reconciled;
  }

  // Best-effort: an approvals-endpoint failure (network hiccup, an instance
  // that has approvals disabled, a stale token missing the extra scope) must
  // not fail the whole sync the way the primary MR list request does — the
  // card still gets everything else, just without an approvals verdict.
  private async fetchGitlabApprovalState(
    baseUrl: string,
    projectId: number | string,
    mrIid: number | string,
    token: string | null,
  ): Promise<GitlabApprovalState | null> {
    const base = trimTrailingSlash(baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const url = `${base}/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/approvals`;
    try {
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { approved?: boolean; approvals_left?: number };
      return {
        approved: body.approved === true,
        approvalsLeft: body.approvals_left ?? 0,
      };
    } catch (error) {
      this.logger?.warn(
        { err: error, projectId, mrIid },
        "Kanban GitLab approval state fetch failed",
      );
      return null;
    }
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
