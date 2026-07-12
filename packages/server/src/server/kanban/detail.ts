import type pino from "pino";
import type {
  KanbanCardDetail,
  KanbanCardDetailAttachment,
  KanbanCardDetailComment,
  StoredKanbanCard,
  StoredKanbanConnection,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { jiraAuthHeaders, resolveKanbanToken, trimTrailingSlash } from "./credentials.js";
import { adfToMarkdown, type AdfMediaResolver } from "./adf-to-markdown.js";
import { KanbanAttachmentTokenStore } from "./attachment-token-store.js";

interface JiraAttachmentApi {
  id: string;
  filename: string;
  mimeType: string;
  // Authenticated download URL — never sent to the client. Proxied instead
  // through /kanban/attachment/:token (see attachment-token-store.ts).
  content: string;
}

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
    attachment?: JiraAttachmentApi[];
  };
}

interface JiraComment {
  author?: { displayName?: string } | null;
  body?: unknown;
  created?: string;
}

interface JiraCommentsResponse {
  comments?: JiraComment[];
  total?: number;
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
function jiraBodyToMarkdown(body: unknown, resolveMedia?: AdfMediaResolver): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  return adfToMarkdown(body, resolveMedia);
}

export interface KanbanCardDetailResult {
  detail: KanbanCardDetail | null;
  error: string | null;
}

export interface KanbanCardCommentsResult {
  comments: KanbanCardDetailComment[] | null;
  error: string | null;
}

// A fetched-but-not-yet-streamed attachment: the caller (bootstrap.ts's HTTP
// route) owns turning `response` into bytes on the wire, keeping express
// concerns out of this file.
export type KanbanAttachmentFetchResult =
  | { status: "not_found" }
  | { status: "upstream_error"; message: string }
  | { status: "ok"; response: Response; mimeType: string };

export interface KanbanCardDetailServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  oauthService?: KanbanOauthService;
  logger?: pino.Logger;
  // Attachment proxy token TTL; overridable for tests. Defaults to 10 minutes.
  attachmentTokenTtlMs?: number;
  now?: () => number;
}

const COMMENT_PAGE_SIZE = 50;
const DEFAULT_ATTACHMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CardContext {
  source: StoredKanbanSource;
  connection: StoredKanbanConnection | null;
  baseUrl: string;
  token: string | null;
}

export class KanbanCardDetailService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;
  private readonly attachmentTokens: KanbanAttachmentTokenStore;

  constructor(options: KanbanCardDetailServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
    this.attachmentTokens = new KanbanAttachmentTokenStore({
      ttlMs: options.attachmentTokenTtlMs ?? DEFAULT_ATTACHMENT_TOKEN_TTL_MS,
      now: options.now,
    });
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

      const context = await this.resolveCardContext(card);
      const detail =
        card.source.kind === "jira"
          ? await this.getJiraDetail(context, card.source.issueKey)
          : await this.getGitlabDetail(context, card.source.projectId, card.source.mrIid);
      return { detail, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error, cardId }, "Kanban card detail fetch failed");
      return { detail: null, error: message };
    }
  }

  // Full comment fetch, split out of getDetail so opening the detail sheet
  // doesn't have to wait on (or pay for) every comment body — the detail
  // response only carries commentCount up front.
  async getComments(cardId: string): Promise<KanbanCardCommentsResult> {
    try {
      const card = await this.store.getCard(cardId);
      if (!card) {
        return { comments: null, error: `Kanban card not found: ${cardId}` };
      }
      if (card.source.kind === "manual") {
        return { comments: [], error: null };
      }

      const context = await this.resolveCardContext(card);
      const comments =
        card.source.kind === "jira"
          ? await this.getJiraComments(context, card.source.issueKey)
          : await this.getGitlabComments(context, card.source.projectId, card.source.mrIid);
      return { comments, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error, cardId }, "Kanban card comments fetch failed");
      return { comments: null, error: message };
    }
  }

  // Resolves and fetches one previously-issued attachment token. Returns a
  // discriminated result rather than throwing so the HTTP route can map each
  // outcome to the right status code without its own try/catch.
  async fetchAttachment(token: string): Promise<KanbanAttachmentFetchResult> {
    const entry = this.attachmentTokens.peekToken(token);
    if (!entry) {
      return { status: "not_found" };
    }
    try {
      const source = await this.store.getSource(entry.sourceId);
      if (!source) {
        return { status: "upstream_error", message: "Kanban source no longer exists" };
      }
      const connection = entry.connectionId
        ? await this.store.getConnection(entry.connectionId)
        : null;
      const kanbanToken = await resolveKanbanToken({
        source,
        connection,
        secrets: this.secrets,
        oauthService: this.oauthService,
      });
      const headers = jiraAuthHeaders(kanbanToken, connection?.email ?? null);
      const response = await this.fetchImpl(entry.downloadUrl, { headers });
      if (!response.ok) {
        return {
          status: "upstream_error",
          message: `Attachment fetch failed: ${response.status} ${response.statusText}`,
        };
      }
      return { status: "ok", response, mimeType: entry.mimeType };
    } catch (error) {
      return {
        status: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      };
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
      commentCount: null,
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

  private async resolveCardContext(card: StoredKanbanCard): Promise<CardContext> {
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
    return { source, connection, baseUrl, token };
  }

  private async getJiraDetail(context: CardContext, issueKey: string): Promise<KanbanCardDetail> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers = jiraAuthHeaders(context.token, context.connection?.email ?? null);
    // Cloud (email present) uses the v3 API with ADF description/comment
    // bodies; Server/DC (Bearer PAT, no email) uses v2 with plain-text bodies.
    const apiVersion = context.connection?.email ? "3" : "2";

    const issue = await this.fetchJiraIssue(base, apiVersion, issueKey, headers);
    const commentCount = await this.fetchJiraCommentCount(base, apiVersion, issueKey, headers);
    const attachments = (issue.fields?.attachment ?? []).map((attachment) =>
      this.issueAttachmentToken(attachment, context.source.id, context.connection?.id ?? null),
    );
    const resolveMedia = this.buildMediaResolver(attachments);

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
      descriptionMarkdown: jiraBodyToMarkdown(fields.description, resolveMedia),
      commentCount,
      attachments,
    };
  }

  private async getJiraComments(
    context: CardContext,
    issueKey: string,
  ): Promise<KanbanCardDetailComment[]> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers = jiraAuthHeaders(context.token, context.connection?.email ?? null);
    const apiVersion = context.connection?.email ? "3" : "2";
    // Comments aren't fetched alongside the issue in getDetail anymore, so
    // resolving media references inside comment bodies costs its own
    // attachment lookup here.
    const attachments = await this.fetchJiraAttachments(
      base,
      apiVersion,
      issueKey,
      headers,
      context.source.id,
      context.connection?.id ?? null,
    );
    const resolveMedia = this.buildMediaResolver(attachments);
    return this.fetchJiraComments(base, apiVersion, issueKey, headers, resolveMedia);
  }

  private async fetchJiraIssue(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
  ): Promise<JiraIssueDetail> {
    const fields =
      "summary,description,status,assignee,reporter,labels,priority,created,updated,attachment";
    const issueUrl = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;
    const issueResponse = await this.fetchImpl(issueUrl, { headers });
    if (!issueResponse.ok) {
      throw new Error(
        `Jira issue detail request failed: ${issueResponse.status} ${issueResponse.statusText}`,
      );
    }
    return (await issueResponse.json()) as JiraIssueDetail;
  }

  private async fetchJiraAttachments(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
    sourceId: string,
    connectionId: string | null,
  ): Promise<KanbanCardDetailAttachment[]> {
    const issueUrl = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}?fields=attachment`;
    const response = await this.fetchImpl(issueUrl, { headers });
    if (!response.ok) {
      throw new Error(
        `Jira issue attachment request failed: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as JiraIssueDetail;
    return (body.fields?.attachment ?? []).map((attachment) =>
      this.issueAttachmentToken(attachment, sourceId, connectionId),
    );
  }

  private issueAttachmentToken(
    attachment: JiraAttachmentApi,
    sourceId: string,
    connectionId: string | null,
  ): KanbanCardDetailAttachment {
    const entry = this.attachmentTokens.issueToken({
      downloadUrl: attachment.content,
      mimeType: attachment.mimeType,
      sourceId,
      connectionId,
    });
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      proxyPath: `/kanban/attachment/${entry.token}`,
    };
  }

  // Jira Cloud's attachment JSON doesn't carry the ADF media node's id (that's
  // a media-services file id, not the REST attachment id) — match by filename
  // via the media node's `alt` text instead. Unmatched media nodes keep the
  // existing `![alt](alt)` placeholder rendering.
  private buildMediaResolver(attachments: KanbanCardDetailAttachment[]): AdfMediaResolver {
    const byFilename = new Map(
      attachments.map((attachment) => [attachment.filename, attachment.proxyPath]),
    );
    return (idOrAlt: string) => byFilename.get(idOrAlt) ?? null;
  }

  // Cheap total via maxResults=0 — avoids paying for every comment body just
  // to show a count on the (not-yet-expanded) detail sheet. A count fetch
  // failure shouldn't fail the whole detail response, so this swallows and
  // logs rather than throwing.
  private async fetchJiraCommentCount(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
  ): Promise<number | null> {
    try {
      const url = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}/comment?maxResults=0`;
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as JiraCommentsResponse;
      return typeof body.total === "number" ? body.total : null;
    } catch (error) {
      this.logger?.warn({ err: error, issueKey }, "Kanban Jira comment count fetch failed");
      return null;
    }
  }

  private async fetchJiraComments(
    base: string,
    apiVersion: string,
    issueKey: string,
    headers: Record<string, string>,
    resolveMedia?: AdfMediaResolver,
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
      bodyMarkdown: jiraBodyToMarkdown(comment.body, resolveMedia) ?? "",
    }));
  }

  private async getGitlabDetail(
    context: CardContext,
    projectId: string,
    mrIid: string,
  ): Promise<KanbanCardDetail> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (context.token) {
      headers["PRIVATE-TOKEN"] = context.token;
    }
    const mrUrl = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}`;
    const mrResponse = await this.fetchImpl(mrUrl, { headers });
    if (!mrResponse.ok) {
      throw new Error(
        `GitLab merge request detail request failed: ${mrResponse.status} ${mrResponse.statusText}`,
      );
    }
    const mr = (await mrResponse.json()) as GitlabMergeRequestDetail;

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
      // GitLab's notes endpoint reports total count via an X-Total response
      // header, but only over the unfiltered (system notes included) note
      // list — that would overcount against the system-note-filtered list
      // getComments returns. Left null rather than show a misleading number;
      // revisit if GitLab's API grows a filtered count.
      commentCount: null,
      // TODO(kanbanAttachments): GitLab images are relative `/uploads/...`
      // markdown paths needing PRIVATE-TOKEN auth, not ADF media nodes — a
      // separate rewrite pass over descriptionMarkdown, not the Jira media
      // resolver above. Left unproxied for now.
    };
  }

  private async getGitlabComments(
    context: CardContext,
    projectId: string,
    mrIid: string,
  ): Promise<KanbanCardDetailComment[]> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (context.token) {
      headers["PRIVATE-TOKEN"] = context.token;
    }
    const notesUrl = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes?sort=asc&per_page=${COMMENT_PAGE_SIZE}`;
    const notesResponse = await this.fetchImpl(notesUrl, { headers });
    if (!notesResponse.ok) {
      throw new Error(
        `GitLab merge request notes request failed: ${notesResponse.status} ${notesResponse.statusText}`,
      );
    }
    const notes = (await notesResponse.json()) as GitlabNote[];
    return (notes ?? [])
      .filter((note) => !note.system)
      .map((note) => ({
        author: note.author?.name ?? null,
        createdAt: note.created_at ?? null,
        bodyMarkdown: note.body ?? "",
      }));
  }
}
