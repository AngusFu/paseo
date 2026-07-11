import type pino from "pino";
import type {
  KanbanCardSource,
  KanbanSourceAuth,
  KanbanStatus,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore, type UpsertKanbanCardBySourcePayload } from "./store.js";

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

// COMPAT(kanbanCredentials): v1 resolves credentials by reading
// process.env[credentialRef] directly. A real OAuth/secret-store integration
// (rotating tokens, encrypted-at-rest storage) is a follow-up.
function resolveCredential(auth: KanbanSourceAuth | undefined): string | null {
  if (!auth) {
    return null;
  }
  const value = process.env[auth.credentialRef];
  return value && value.length > 0 ? value : null;
}

export interface KanbanSyncResult {
  source: StoredKanbanSource | null;
  cards: StoredKanbanCard[];
  error: string | null;
}

export interface KanbanSyncServiceOptions {
  store: KanbanStore;
  fetchImpl: typeof fetch;
  logger?: pino.Logger;
}

export class KanbanSyncService {
  private readonly store: KanbanStore;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: pino.Logger;

  constructor(options: KanbanSyncServiceOptions) {
    this.store = options.store;
    this.fetchImpl = options.fetchImpl;
    this.logger = options.logger;
  }

  async sync(source: StoredKanbanSource): Promise<KanbanSyncResult> {
    try {
      const token = resolveCredential(source.auth);
      const upserts =
        source.kind === "jira"
          ? (await this.fetchJiraIssues(source, token)).map((issue) =>
              this.buildJiraUpsert(source, issue),
            )
          : (await this.fetchGitlabMergeRequests(source, token)).map((mr) =>
              this.buildGitlabUpsert(source, mr),
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

  private async fetchJiraIssues(
    source: StoredKanbanSource,
    token: string | null,
  ): Promise<JiraIssue[]> {
    const url = `${trimTrailingSlash(source.baseUrl)}/rest/api/2/search?jql=${encodeURIComponent(source.query)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`Jira sync request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as JiraSearchResponse;
    return body.issues ?? [];
  }

  private async fetchGitlabMergeRequests(
    source: StoredKanbanSource,
    token: string | null,
  ): Promise<GitlabMergeRequest[]> {
    const url = `${trimTrailingSlash(source.baseUrl)}/api/v4/merge_requests?${source.query}`;
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
        url: `${trimTrailingSlash(source.baseUrl)}/browse/${issue.key}`,
        status: mapExternalStatus(externalStatus, JIRA_DEFAULT_STATUS_MAP, source.statusMap),
        theme: "jira",
        labels: issue.fields?.labels,
        assignee: issue.fields?.assignee?.displayName ?? null,
        metadata: issue.fields as Record<string, unknown> | undefined,
      },
    };
  }

  private buildGitlabUpsert(
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
        url: mr.web_url ?? `${trimTrailingSlash(source.baseUrl)}/-/merge_requests/${mrIid}`,
        status: mapExternalStatus(externalStatusKey, GITLAB_DEFAULT_STATUS_MAP, source.statusMap),
        theme: "gitlab-mr",
        labels: mr.labels,
        assignee: mr.assignee?.name ?? null,
        metadata: mr as unknown as Record<string, unknown>,
      },
    };
  }
}
