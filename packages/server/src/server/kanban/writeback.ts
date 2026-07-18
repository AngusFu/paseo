/**
 * Jira write-back: real transitions, comments, from Paseo back to the
 * tracker. Jira-only — every method rejects a non-jira card with an
 * explicit error rather than silently no-op'ing (see docs request from
 * product: drag → real Jira transition, detail sheet → real comment).
 *
 * A transition changes the ISSUE'S status in Jira first; the local card's
 * status/columnId are then written from the post-transition issue fetch via
 * KanbanStore.applyExternalTransition, which never sets statusPinnedByUser —
 * Jira is authoritative here, unlike a manual drag/edit that has nothing to
 * reconcile against.
 */
import type pino from "pino";
import type {
  KanbanCardDetailComment,
  KanbanCardTransition,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { jiraAuthHeaders, trimTrailingSlash } from "./credentials.js";
import { resolveKanbanCardContext, type KanbanCardContext } from "./card-context.js";
import { jiraCategoryLegacyStatus } from "./sync.js";

interface JiraTransitionApi {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

interface JiraTransitionsResponse {
  transitions?: JiraTransitionApi[];
}

interface JiraIssueStatusResponse {
  fields?: { status?: JiraIssueStatus };
}

interface JiraIssueStatus {
  name?: string;
  statusCategory?: { key?: string };
  [key: string]: unknown;
}

interface JiraCreatedComment {
  author?: { displayName?: string } | null;
  body?: unknown;
  created?: string;
}

type JiraStoredKanbanCard = StoredKanbanCard & {
  source: Extract<StoredKanbanCard["source"], { kind: "jira" }>;
};

export interface KanbanCardTransitionsResult {
  transitions: KanbanCardTransition[] | null;
  error: string | null;
}

export interface KanbanCardTransitionResult {
  card: StoredKanbanCard | null;
  error: string | null;
}

export interface KanbanCardAddCommentResult {
  comment: KanbanCardDetailComment | null;
  error: string | null;
}

export interface KanbanCardWriteBackServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  oauthService?: KanbanOauthService;
  logger?: pino.Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Minimal ADF doc wrapping plain text — one paragraph per input line, no
// markdown parsing. Jira Cloud (v3 API) requires ADF for comment bodies;
// Server/DC (v2 API) takes the plain string directly (see bodyForApiVersion).
function plainTextToAdf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

export class KanbanCardWriteBackService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly oauthService?: KanbanOauthService;
  private readonly logger?: pino.Logger;

  constructor(options: KanbanCardWriteBackServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.oauthService = options.oauthService;
    this.logger = options.logger;
  }

  async listTransitions(cardId: string): Promise<KanbanCardTransitionsResult> {
    try {
      const card = await this.requireJiraCard(cardId);
      const context = await this.resolveContext(card);
      const transitions = await this.fetchJiraTransitions(context, card.source.issueKey);
      return { transitions, error: null };
    } catch (error) {
      this.logger?.warn({ err: error, cardId }, "Kanban Jira transitions fetch failed");
      return { transitions: null, error: errorMessage(error) };
    }
  }

  async applyTransition(cardId: string, transitionId: string): Promise<KanbanCardTransitionResult> {
    try {
      const card = await this.requireJiraCard(cardId);
      const context = await this.resolveContext(card);
      await this.postJiraTransition(context, card.source.issueKey, transitionId);
      const externalStatus = await this.fetchJiraIssueStatus(context, card.source.issueKey);
      const column = await this.store.resolveColumnForSync({
        columnIdOverride: context.source.columnMap?.[externalStatus.name],
        legacyStatusOverride: context.source.statusMap?.[externalStatus.name],
        categoryLegacyStatus: jiraCategoryLegacyStatus(externalStatus.categoryKey),
      });
      const updated = await this.store.applyExternalTransition(cardId, {
        status: column.legacyStatus,
        columnId: column.id,
        // Same raw {name, statusCategory, ...} object sync.ts stores under
        // metadata.status — keeps the Jira board's lane lookup (which reads
        // metadata.status.name) in sync with the transition it just caused,
        // instead of relying on the next periodic sync to catch up.
        metadataStatus: externalStatus.raw,
      });
      return { card: updated, error: updated ? null : `Kanban card not found: ${cardId}` };
    } catch (error) {
      this.logger?.warn({ err: error, cardId, transitionId }, "Kanban Jira transition failed");
      return { card: null, error: errorMessage(error) };
    }
  }

  async addComment(cardId: string, body: string): Promise<KanbanCardAddCommentResult> {
    try {
      const card = await this.requireJiraCard(cardId);
      const context = await this.resolveContext(card);
      const comment = await this.postJiraComment(context, card.source.issueKey, body);
      return { comment, error: null };
    } catch (error) {
      this.logger?.warn({ err: error, cardId }, "Kanban Jira comment post failed");
      return { comment: null, error: errorMessage(error) };
    }
  }

  private async requireJiraCard(cardId: string): Promise<JiraStoredKanbanCard> {
    const card = await this.store.getCard(cardId);
    if (!card) {
      throw new Error(`Kanban card not found: ${cardId}`);
    }
    if (card.source.kind !== "jira") {
      throw new Error("This action is only available for Jira cards");
    }
    return card as JiraStoredKanbanCard;
  }

  private async resolveContext(card: StoredKanbanCard): Promise<KanbanCardContext> {
    return resolveKanbanCardContext(
      { store: this.store, secrets: this.secrets, oauthService: this.oauthService },
      card,
    );
  }

  private apiVersion(context: KanbanCardContext): string {
    // Cloud (email present on the connection) uses v3; Server/DC (Bearer
    // PAT, no email) uses v2 — same detection sync.ts/detail.ts use.
    return context.connection?.email ? "3" : "2";
  }

  private async fetchJiraTransitions(
    context: KanbanCardContext,
    issueKey: string,
  ): Promise<KanbanCardTransition[]> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers = jiraAuthHeaders(context.token, context.connection?.email ?? null);
    const url = `${base}/rest/api/${this.apiVersion(context)}/issue/${encodeURIComponent(issueKey)}/transitions`;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`Jira transitions request failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as JiraTransitionsResponse;
    return (body.transitions ?? []).map((transition) => ({
      id: transition.id,
      name: transition.name,
      toStatusName: transition.to?.name,
    }));
  }

  private async postJiraTransition(
    context: KanbanCardContext,
    issueKey: string,
    transitionId: string,
  ): Promise<void> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers = {
      ...jiraAuthHeaders(context.token, context.connection?.email ?? null),
      "Content-Type": "application/json",
    };
    const url = `${base}/rest/api/${this.apiVersion(context)}/issue/${encodeURIComponent(issueKey)}/transitions`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!response.ok) {
      throw new Error(`Jira transition request failed: ${response.status} ${response.statusText}`);
    }
  }

  private async fetchJiraIssueStatus(
    context: KanbanCardContext,
    issueKey: string,
  ): Promise<{ name: string; categoryKey: string | undefined; raw: JiraIssueStatus | undefined }> {
    const base = trimTrailingSlash(context.baseUrl);
    const headers = jiraAuthHeaders(context.token, context.connection?.email ?? null);
    const url = `${base}/rest/api/${this.apiVersion(context)}/issue/${encodeURIComponent(issueKey)}?fields=status`;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Jira issue status refetch failed: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as JiraIssueStatusResponse;
    const status = body.fields?.status;
    return { name: status?.name ?? "", categoryKey: status?.statusCategory?.key, raw: status };
  }

  private async postJiraComment(
    context: KanbanCardContext,
    issueKey: string,
    text: string,
  ): Promise<KanbanCardDetailComment> {
    const base = trimTrailingSlash(context.baseUrl);
    const apiVersion = this.apiVersion(context);
    const headers = {
      ...jiraAuthHeaders(context.token, context.connection?.email ?? null),
      "Content-Type": "application/json",
    };
    // Cloud (v3) requires ADF; Server/DC (v2) takes the plain string.
    const requestBody = apiVersion === "3" ? plainTextToAdf(text) : text;
    const url = `${base}/rest/api/${apiVersion}/issue/${encodeURIComponent(issueKey)}/comment`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: requestBody }),
    });
    if (!response.ok) {
      throw new Error(`Jira add comment request failed: ${response.status} ${response.statusText}`);
    }
    const created = (await response.json()) as JiraCreatedComment;
    return {
      author: created.author?.displayName ?? null,
      createdAt: created.created ?? null,
      // Echo back the plain text we sent rather than re-parsing whatever
      // Jira stored it as (ADF on Cloud) — it's the same content either way,
      // and the caller doesn't need a second render pass for its own comment.
      bodyMarkdown: text,
    };
  }
}
