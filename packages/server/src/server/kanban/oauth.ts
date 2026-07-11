import { randomBytes } from "node:crypto";
import type pino from "pino";
import type { KanbanSourceKind, StoredKanbanConnection } from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";
import { KanbanSecretsStore, type KanbanOauthSecret } from "./secrets-store.js";

const STATE_TTL_MS = 10 * 60 * 1000;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// credentialRef is derived from the connection id — one secret per
// connection, so no separate id generation/bookkeeping is needed.
export function credentialRefForConnection(connectionId: string): string {
  return `kbn_secret_${connectionId}`;
}

interface OauthEndpoints {
  authorize: string;
  token: string;
  scope: string;
}

// Endpoints always derive from the connection's baseUrl — never hardcode
// gitlab.com or atlassian.net, self-hosted instances use their own domain
// (see the doc comment on StoredKanbanConnectionSchema.baseUrl).
function oauthEndpoints(kind: KanbanSourceKind, baseUrl: string): OauthEndpoints {
  const base = trimTrailingSlash(baseUrl);
  if (kind === "gitlab") {
    return {
      authorize: `${base}/oauth/authorize`,
      token: `${base}/oauth/token`,
      scope: "read_api",
    };
  }
  // COMPAT/TODO(kanbanJiraCloudOauth): this is the Jira Server/DC "OAuth 2.0
  // Provider Plugin" endpoint convention. Jira Cloud instances authenticate
  // through Atlassian's centralized auth.atlassian.com 3LO flow instead — v1
  // only supports self-hosted Jira Server/DC OAuth apps.
  return {
    authorize: `${base}/rest/oauth2/latest/authorize`,
    token: `${base}/rest/oauth2/latest/token`,
    scope: "read:jira-work",
  };
}

interface OauthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function expiresAtFromNow(expiresInSec: number | undefined): string | null {
  if (!expiresInSec) {
    return null;
  }
  return new Date(Date.now() + expiresInSec * 1000).toISOString();
}

interface PendingAuthorization {
  connectionId: string;
  redirectUri: string;
  createdAt: number;
}

export interface KanbanOauthServiceOptions {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
  fetchImpl: typeof fetch;
  logger?: pino.Logger;
}

export interface KanbanOauthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
}

// Owns the authorization-code flow for a KanbanConnection: build the provider
// authorize URL, track the single-use state token, exchange the callback code
// for tokens, and refresh an expiring access token. Tokens land in
// KanbanSecretsStore; only authConnected is ever written back to
// StoredKanbanConnection.
export class KanbanOauthService {
  private readonly store: KanbanStore;
  private readonly secrets: KanbanSecretsStore;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: pino.Logger;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(options: KanbanOauthServiceOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.logger = options.logger;
  }

  startAuthorization(
    connection: StoredKanbanConnection,
    redirectUri: string,
  ): { authorizeUrl: string } {
    if (!connection.oauthClientId) {
      throw new Error("Kanban connection is missing an OAuth client id");
    }
    this.sweepExpiredState();
    const state = randomBytes(16).toString("hex");
    this.pending.set(state, { connectionId: connection.id, redirectUri, createdAt: Date.now() });
    const { authorize, scope } = oauthEndpoints(connection.kind, connection.baseUrl);
    const url = new URL(authorize);
    url.searchParams.set("client_id", connection.oauthClientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    return { authorizeUrl: url.toString() };
  }

  async handleCallback(params: KanbanOauthCallbackParams): Promise<{ connectionId: string }> {
    if (params.error) {
      throw new Error(`OAuth authorization was rejected: ${params.error}`);
    }
    if (!params.state) {
      throw new Error("Missing OAuth state parameter");
    }
    const pending = this.pending.get(params.state);
    // Single-use: consume the state token immediately, valid or not.
    this.pending.delete(params.state);
    if (!pending) {
      throw new Error("Unknown or already-used OAuth state");
    }
    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      throw new Error("OAuth state expired, please retry connecting");
    }
    if (!params.code) {
      throw new Error("Missing OAuth authorization code");
    }

    const connection = await this.store.getConnection(pending.connectionId);
    if (!connection) {
      throw new Error(`Kanban connection not found: ${pending.connectionId}`);
    }
    if (!connection.oauthClientId) {
      throw new Error("Kanban connection is missing an OAuth client id");
    }

    const credentialRef = credentialRefForConnection(connection.id);
    const existing = await this.secrets.get(credentialRef);
    const clientSecret = existing?.method === "oauth" ? existing.clientSecret : "";

    const { token: tokenEndpoint } = oauthEndpoints(connection.kind, connection.baseUrl);
    const tokenResponse = await this.exchangeToken(tokenEndpoint, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: pending.redirectUri,
      client_id: connection.oauthClientId,
      client_secret: clientSecret,
    });

    const expiresAt = expiresAtFromNow(tokenResponse.expires_in);
    const secret: KanbanOauthSecret = {
      method: "oauth",
      clientId: connection.oauthClientId,
      clientSecret,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt,
    };
    await this.secrets.set(credentialRef, secret);
    await this.store.setConnectionAuthConnected(connection.id, true);
    this.logger?.info({ connectionId: connection.id }, "Kanban connection connected via OAuth");
    return { connectionId: connection.id };
  }

  async refreshAccessToken(
    connection: StoredKanbanConnection,
    secret: KanbanOauthSecret,
  ): Promise<KanbanOauthSecret> {
    if (!secret.refreshToken) {
      throw new Error("Kanban connection has no OAuth refresh token available");
    }
    const { token: tokenEndpoint } = oauthEndpoints(connection.kind, connection.baseUrl);
    const tokenResponse = await this.exchangeToken(tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken,
      client_id: secret.clientId,
      client_secret: secret.clientSecret,
    });
    const updated: KanbanOauthSecret = {
      ...secret,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? secret.refreshToken,
      expiresAt: expiresAtFromNow(tokenResponse.expires_in),
    };
    await this.secrets.set(credentialRefForConnection(connection.id), updated);
    return updated;
  }

  private async exchangeToken(
    tokenEndpoint: string,
    params: Record<string, string>,
  ): Promise<OauthTokenResponse> {
    const response = await this.fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new Error(`OAuth token request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as OauthTokenResponse;
  }

  private sweepExpiredState(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) {
      if (now - pending.createdAt > STATE_TTL_MS) {
        this.pending.delete(state);
      }
    }
  }
}
