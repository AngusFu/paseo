import type pino from "pino";
import type {
  KanbanCardDetail,
  KanbanCardDetailComment,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { jiraAuthHeaders, resolveKanbanToken, trimTrailingSlash } from "./credentials.js";
import { adfToMarkdown } from "./adf-to-markdown.js";

interface JiraIssueDetail {
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    labels?: string[];
    priority?: { name?: string } | null;
    created?: string;
    updated?: string;
  };
}

interface JiraComment {
  author?: { displayName?: string } | null;
  body?: unknown;
  created?: string;
}

interface JiraCommentsResponse {
  comments?: JiraComment[];
}

interface GitlabMergeRequestDetail {
  iid: number | string;
  title: string;
  web_url?: string;
  state?: string;
  description?: string | null;
  author?: { name?: string } | null;
  assignee?: { name?: string } | null;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
}

interface GitlabNote {
  author?: { name?: string } | null;
  body?: string;
  created_at?: string;
  system?: boolean;
}

// Jira's description/comment body is ADF JSON on Cloud (the email-auth route)
// and a plain wiki-markup string on Server/DC — pass the string through as-is
// rather than trying to render wiki markup.
function jiraBodyToMarkdown(body: unknown): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  return adfToMarkdown(body);
}

function jiraIssueToDetail(
  base: string,
  issue: JiraIssueDetail,
  comments: KanbanCardDetailComment[],
): KanbanCardDetail {
  const fields = issue.fields ?? {};
  return {
    title: fields.summary ?? issue.key,
    url: `${base}/browse/${issue.key}`,
    externalStatus: fields.status?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    reporter: fields.reporter?.displayName ?? null,
    labels: fields.labels ?? [],
    priority: fields.priority?.name ?? null,
    createdAt: fields.created ?? null,
    updatedAt: fields.updated ?? null,
    descriptionMarkdown: jiraBodyToMarkdown(fields.description),
    comments,
  };
}

export interface KanbanCardDetailResult {
  detail: KanbanCardDetail | null;
  error: string | null;
}

export interface KanbanCardDetailServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  oauthService?: KanbanOauthService;
  logger?: pino.Logger;
}

const COMMENT_PAGE_SIZE = 50;

export class KanbanCardDetailService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;

  constructor(options: KanbanCardDetailServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
  }

  async getDetail(cardId: string): Promise<KanbanCardDetailResult> {
    try {
      const card = await this.store.getCard(cardId);
      if (!card) {
        return { detail: null, error: `Kanban card not found: ${cardId}` };
      }
      if (card.source.kind === "manual") {
        // A manual card has no external tracker to fetch from — return the
        // fields Paseo already has instead of an error, so the detail sheet
        // still renders something for every card kind.
        return { detail: this.manualCardDetail(card), error: null };
      }

      const source = await this.resolveSourceForCard(card);
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

      const detail =
        card.source.kind === "jira"
          ? await this.getJiraDetail(
              baseUrl,
              card.source.issueKey,
              token,
              connection?.email ?? null,
            )
          : await this.getGitlabDetail(baseUrl, card.source.projectId, card.source.mrIid, token);
      return { detail, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error, cardId }, "Kanban card detail fetch failed");
      return { detail: null, error: message };
    }
  }

  private manualCardDetail(card: StoredKanbanCard): KanbanCardDetail {
    return {
      title: card.title,
      url: card.url,
      externalStatus: null,
      assignee: card.assignee ?? null,
      reporter: null,
      labels: card.labels ?? [],
      priority: card.priority ?? null,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      descriptionMarkdown: null,
      comments: [],
    };
  }

  // A card doesn't record which KanbanSource created it — only the tracker
  // identity (issueKey / projectId+mrIid). Match by kind, then narrow by
  // whether the card's URL sits under that source's instance baseUrl; if
  // that's ambiguous or the card has no URL, fall back to the first source
  // of that kind. Good enough for the common case (one source per instance);
  // multiple same-kind sources pointed at different instances for the same
  // card's tracker is not resolvable from the data we have today.
  private async resolveSourceForCard(card: StoredKanbanCard): Promise<StoredKanbanSource> {
    const sources = (await this.store.listSources()).filter(
      (source) => source.kind === card.source.kind,
    );
    if (sources.length === 0) {
      throw new Error(`No kanban source configured for ${card.source.kind} cards`);
    }
    if (sources.length === 1 || !card.url) {
      return sources[0];
    }
    for (const source of sources) {
      const connection = source.connectionId
        ? await this.store.getConnection(source.connectionId)
        : null;
      const baseUrl = connection?.baseUrl ?? source.baseUrl;
      if (baseUrl && card.url.startsWith(trimTrailingSlash(baseUrl))) {
        return source;
      }
    }
    return sources[0];
  }

  private async getJiraDetail(
    baseUrl: string,
    issueKey: string,
    token: string | null,
    email: string | null,
  ): Promise<KanbanCardDetail> {
    const base = trimTrailingSlash(baseUrl);
    const headers = jiraAuthHeaders(token, email);
    // Cloud (email present) uses the v3 API with ADF description/comment
    // bodies; Server/DC (Bearer PAT, no email) uses v2 with plain-text bodies.
    const apiVersion = email ? "3" : "2";

    const issue = await this.fetchJiraIssue(base, apiVersion, issueKey, headers);
    const comments = await this.fetchJiraComments(base, apiVersion, issueKey, headers);
    return jiraIssueToDetail(base, issue, comments);
  }

  private async fetchJiraIssue(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
  ): Promise<JiraIssueDetail> {
    const fields = "summary,description,status,assignee,reporter,labels,priority,created,updated";
    const issueUrl = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;
    const issueResponse = await this.fetchImpl(issueUrl, { headers });
    if (!issueResponse.ok) {
      throw new Error(
        `Jira issue detail request failed: ${issueResponse.status} ${issueResponse.statusText}`,
      );
    }
    return (await issueResponse.json()) as JiraIssueDetail;
  }

  private async fetchJiraComments(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
  ): Promise<KanbanCardDetailComment[]> {
    const commentsUrl = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}/comment?maxResults=${COMMENT_PAGE_SIZE}&orderBy=created`;
    const commentsResponse = await this.fetchImpl(commentsUrl, { headers });
    if (!commentsResponse.ok) {
      throw new Error(
        `Jira issue comments request failed: ${commentsResponse.status} ${commentsResponse.statusText}`,
      );
    }
    const commentsBody = (await commentsResponse.json()) as JiraCommentsResponse;
    return (commentsBody.comments ?? []).map((comment) => ({
      author: comment.author?.displayName ?? null,
      createdAt: comment.created ?? null,
      bodyMarkdown: jiraBodyToMarkdown(comment.body) ?? "",
    }));
  }

  private async getGitlabDetail(
    baseUrl: string,
    projectId: string,
    mrIid: string,
    token: string | null,
  ): Promise<KanbanCardDetail> {
    const base = trimTrailingSlash(baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["PRIVATE-TOKEN"] = token;
    }
    const mrUrl = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}`;
    const mrResponse = await this.fetchImpl(mrUrl, { headers });
    if (!mrResponse.ok) {
      throw new Error(
        `GitLab merge request detail request failed: ${mrResponse.status} ${mrResponse.statusText}`,
      );
    }
    const mr = (await mrResponse.json()) as GitlabMergeRequestDetail;

    const notesUrl = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes?sort=asc&per_page=${COMMENT_PAGE_SIZE}`;
    const notesResponse = await this.fetchImpl(notesUrl, { headers });
    if (!notesResponse.ok) {
      throw new Error(
        `GitLab merge request notes request failed: ${notesResponse.status} ${notesResponse.statusText}`,
      );
    }
    const notes = (await notesResponse.json()) as GitlabNote[];

    const comments: KanbanCardDetailComment[] = (notes ?? [])
      .filter((note) => !note.system)
      .map((note) => ({
        author: note.author?.name ?? null,
        createdAt: note.created_at ?? null,
        bodyMarkdown: note.body ?? "",
      }));

    return {
      title: mr.title,
      url: mr.web_url ?? `${base}/-/merge_requests/${mrIid}`,
      externalStatus: mr.state ?? null,
      assignee: mr.assignee?.name ?? null,
      reporter: mr.author?.name ?? null,
      labels: mr.labels ?? [],
      // GitLab merge requests have no native priority field.
      priority: null,
      createdAt: mr.created_at ?? null,
      updatedAt: mr.updated_at ?? null,
      descriptionMarkdown: mr.description ?? null,
      comments,
    };
  }
}
