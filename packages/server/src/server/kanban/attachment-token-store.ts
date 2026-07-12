import { randomUUID } from "node:crypto";

// Unlike DownloadTokenStore (single-use, consumed on first read — see
// file-download/token-store.ts), a Jira attachment token backs an <img> that
// a detail sheet may render more than once (re-open, scroll back into view).
// Tokens are therefore peeked, not consumed, and simply expire after the TTL.
// The token itself is the endpoint's only authorization (see bootstrap.ts's
// /kanban/attachment/:token route and the BEARER_AUTH_BYPASS_PATHS comment
// in auth.ts) — anyone holding it can fetch the one attachment it points to
// until it expires, but nothing else.
export interface KanbanAttachmentTokenEntry {
  token: string;
  // The tracker's authenticated download URL — never sent to the client.
  downloadUrl: string;
  mimeType: string;
  // Identifies which source/connection to re-resolve credentials from at
  // fetch time (so an about-to-expire OAuth token gets refreshed rather than
  // captured stale at issuance time).
  sourceId: string;
  connectionId: string | null;
  expiresAt: number;
}

interface KanbanAttachmentTokenStoreOptions {
  ttlMs: number;
  now?: () => number;
}

export class KanbanAttachmentTokenStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, KanbanAttachmentTokenEntry>();

  constructor(options: KanbanAttachmentTokenStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  issueToken(
    input: Omit<KanbanAttachmentTokenEntry, "token" | "expiresAt">,
  ): KanbanAttachmentTokenEntry {
    this.pruneExpired();
    const token = randomUUID();
    const entry: KanbanAttachmentTokenEntry = {
      ...input,
      token,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tokens.set(token, entry);
    return entry;
  }

  // Not consuming: the same detail page can re-render the same image
  // multiple times while the token is still live.
  peekToken(token: string): KanbanAttachmentTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
