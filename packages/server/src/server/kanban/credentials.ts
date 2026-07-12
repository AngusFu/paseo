import type { StoredKanbanConnection, StoredKanbanSource } from "@getpaseo/protocol/kanban/types";
import type { KanbanSecretsStore } from "./secrets-store.js";
import { credentialRefForConnection, type KanbanOauthService } from "./oauth.js";

// An access token is refreshed once it's within this window of expiring,
// rather than waiting for the provider to reject an already-stale request.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface ResolveKanbanTokenOptions {
  source: StoredKanbanSource;
  connection: StoredKanbanConnection | null;
  secrets: KanbanSecretsStore;
  // Only needed to refresh an expiring OAuth access token before use.
  oauthService?: KanbanOauthService;
}

// Resolves the bearer/PAT value to send upstream. Primary route: the source
// points at a reusable connection, whose credential is keyed by
// credentialRefForConnection(connection.id) — refreshes an about-to-expire
// OAuth token first. Legacy route (no connection): looks up
// source.auth.credentialRef directly, falling back to an env var of the
// same name for scripts/tests that configure credentials that way
// (COMPAT(kanbanCredentials): pre-secrets-store v1 behavior, kept as a
// fallback rather than removed).
export async function resolveKanbanToken(
  options: ResolveKanbanTokenOptions,
): Promise<string | null> {
  const { source, connection, secrets, oauthService } = options;
  if (connection) {
    return resolveConnectionToken(connection, secrets, oauthService);
  }
  if (!source.auth) {
    return null;
  }
  const secret = await secrets.get(source.auth.credentialRef);
  if (!secret) {
    const envValue = process.env[source.auth.credentialRef];
    return envValue && envValue.length > 0 ? envValue : null;
  }
  return secret.method === "token" ? secret.token : secret.accessToken;
}

async function resolveConnectionToken(
  connection: StoredKanbanConnection,
  secrets: KanbanSecretsStore,
  oauthService?: KanbanOauthService,
): Promise<string | null> {
  const secret = await secrets.get(credentialRefForConnection(connection.id));
  if (!secret) {
    return null;
  }
  if (secret.method === "token") {
    return secret.token;
  }
  const expiringSoon =
    secret.expiresAt !== null &&
    new Date(secret.expiresAt).getTime() - Date.now() < TOKEN_REFRESH_SKEW_MS;
  if (expiringSoon && secret.refreshToken && oauthService) {
    const refreshed = await oauthService.refreshAccessToken(connection, secret);
    return refreshed.accessToken;
  }
  return secret.accessToken;
}

// Jira Cloud REST auth is HTTP Basic base64(email:apiToken). Jira Server/DC
// Personal Access Tokens use Bearer, so fall back to Bearer without an email.
export function jiraAuthHeaders(
  token: string | null,
  email: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = email
      ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
      : `Bearer ${token}`;
  }
  return headers;
}
