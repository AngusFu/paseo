/**
 * Shared "resolve a card back to its tracker connection" seam. Both the card
 * detail fetch (detail.ts) and the Jira write-back RPCs (writeback.ts) start
 * from a cardId and need the same {source, connection, baseUrl, token}
 * before they can call the external tracker — this used to be copy-pasted
 * per file; now there's one copy.
 */
import type {
  StoredKanbanCard,
  StoredKanbanConnection,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import type { KanbanStore } from "./store.js";
import type { KanbanSecretsStore } from "./secrets-store.js";
import type { KanbanOauthService } from "./oauth.js";
import { resolveKanbanToken, trimTrailingSlash } from "./credentials.js";

export interface KanbanCardContext {
  source: StoredKanbanSource;
  connection: StoredKanbanConnection | null;
  baseUrl: string;
  token: string | null;
}

export interface ResolveKanbanCardContextDeps {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  oauthService?: KanbanOauthService;
}

// A card doesn't record which KanbanSource created it — only the tracker
// identity (issueKey / projectId+mrIid). Match by kind, then narrow by
// whether the card's URL sits under that source's instance baseUrl; if
// that's ambiguous or the card has no URL, fall back to the first source
// of that kind. Good enough for the common case (one source per instance);
// multiple same-kind sources pointed at different instances for the same
// card's tracker is not resolvable from the data we have today.
export async function resolveSourceForCard(
  store: KanbanStore,
  card: StoredKanbanCard,
): Promise<StoredKanbanSource> {
  const sources = (await store.listSources()).filter((source) => source.kind === card.source.kind);
  if (sources.length === 0) {
    throw new Error(`No kanban source configured for ${card.source.kind} cards`);
  }
  if (sources.length === 1 || !card.url) {
    return sources[0];
  }
  for (const source of sources) {
    const connection = source.connectionId ? await store.getConnection(source.connectionId) : null;
    const baseUrl = connection?.baseUrl ?? source.baseUrl;
    if (baseUrl && card.url.startsWith(trimTrailingSlash(baseUrl))) {
      return source;
    }
  }
  return sources[0];
}

export async function resolveKanbanCardContext(
  deps: ResolveKanbanCardContextDeps,
  card: StoredKanbanCard,
): Promise<KanbanCardContext> {
  const source = await resolveSourceForCard(deps.store, card);
  const connection = source.connectionId
    ? await deps.store.getConnection(source.connectionId)
    : null;
  const baseUrl = connection?.baseUrl ?? source.baseUrl;
  if (!baseUrl) {
    throw new Error("Kanban source has no connection and no baseUrl configured");
  }
  const token = await resolveKanbanToken({
    source,
    connection,
    secrets: deps.secrets,
    oauthService: deps.oauthService,
  });
  return { source, connection, baseUrl, token };
}
