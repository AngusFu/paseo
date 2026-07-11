import { z } from "zod";
import { ScheduleTargetSchema } from "../schedule/types.js";

// The six fixed Kanban columns. Column order (left → right) lives in
// KANBAN_STATUS_ORDER; the enum itself is order-agnostic.
export const KanbanStatusSchema = z.enum(["pending", "wip", "done", "skip", "fail", "abort"]);
export type KanbanStatus = z.infer<typeof KanbanStatusSchema>;

// Board column order (left → right). App and CLI share this constant so the
// six columns render identically everywhere.
export const KANBAN_STATUS_ORDER = ["pending", "wip", "done", "skip", "fail", "abort"] as const;

export const KanbanPrioritySchema = z.enum(["low", "med", "high"]);
export type KanbanPriority = z.infer<typeof KanbanPrioritySchema>;

// Where a card came from. `kind` is part of the (kind, externalId) idempotency
// key used by source sync so repeated polls upsert instead of duplicating.
export const KanbanCardSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("jira"),
    externalId: z.string(),
    project: z.string().optional(),
    issueKey: z.string(),
  }),
  z.object({
    kind: z.literal("gitlab"),
    externalId: z.string(),
    projectId: z.string(),
    mrIid: z.string(),
  }),
]);
export type KanbanCardSource = z.infer<typeof KanbanCardSourceSchema>;

// auto-loop hook (design detail D). v1 stores this but does NOT execute it.
// The terminal auto-loop goal subscribes to status changes, reads this trigger,
// and calls the existing schedule command-runner. No data-model change needed then.
export const KanbanCardTriggerSchema = z.object({
  onStatus: KanbanStatusSchema,
  target: ScheduleTargetSchema,
});
export type KanbanCardTrigger = z.infer<typeof KanbanCardTriggerSchema>;

export const StoredKanbanCardSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  url: z.string().nullable(),
  status: KanbanStatusSchema,
  // "jira" | "gitlab-mr" | "#RRGGBB". Render layer resolves to {icon, color};
  // an unrecognized value falls back to the default grey accent.
  theme: z.string(),
  source: KanbanCardSourceSchema,
  // (source.kind, externalId) idempotency key, e.g. "jira:PROJ-123". null for manual cards.
  externalId: z.string().nullable(),
  // Sort position within a column (ascending). v1 appends: a new or moved card
  // takes max(order)+1 for its column, so a move never rewrites sibling cards.
  // The type is a float to leave room for future midpoint reinsertion.
  order: z.number(),
  // Set true once the user drags the card between columns; source sync then
  // stops overwriting `status` for this card (title/url/metadata still update).
  statusPinnedByUser: z.boolean(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),
  priority: KanbanPrioritySchema.nullable().optional(),
  trigger: KanbanCardTriggerSchema.optional(),
  // Raw source fields (e.g. jira status name, gitlab pipeline status) kept for
  // display fallback and future auto-loop decisions.
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredKanbanCard = z.infer<typeof StoredKanbanCardSchema>;

export const KanbanSourceKindSchema = z.enum(["jira", "gitlab"]);
export type KanbanSourceKind = z.infer<typeof KanbanSourceKindSchema>;

// Credentials live in the daemon secret store; only a reference is persisted here.
export const KanbanSourceAuthSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("token"), credentialRef: z.string() }),
  z.object({
    method: z.literal("oauth"),
    credentialRef: z.string(),
    expiresAt: z.string().nullable().optional(),
  }),
]);
export type KanbanSourceAuth = z.infer<typeof KanbanSourceAuthSchema>;

export const StoredKanbanSourceSchema = z.object({
  id: z.string(),
  kind: KanbanSourceKindSchema,
  name: z.string(),
  enabled: z.boolean(),
  // Instance base URL. NEVER hardcode gitlab.com / atlassian.net — self-host
  // instances and Jira Server/DC use their own domain. All API/OAuth endpoints
  // and status maps derive from this.
  // The instance + auth now live on a reusable KanbanConnection; a source points
  // at one via connectionId. baseUrl is kept optional for the legacy CLI path
  // that embeds an instance directly, but connectionId is the primary route.
  connectionId: z.string().nullable().optional(),
  baseUrl: z.string().optional(),
  // jira = JQL; gitlab = MR filter string.
  query: z.string(),
  // externalStatus → kanbanStatus override table. Missing keys fall back to the
  // built-in default map in the sync mapper.
  statusMap: z.record(z.string(), KanbanStatusSchema).optional(),
  pollEverySec: z.number().int().positive(),
  auth: KanbanSourceAuthSchema.optional(),
  lastSyncAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredKanbanSource = z.infer<typeof StoredKanbanSourceSchema>;

// A reusable Jira/GitLab connection: one instance + one authorization, shared by
// any number of kanban sources. Managed in Settings. The client secret and the
// issued OAuth/PAT tokens live in $PASEO_HOME/kanban/secrets.json keyed by the
// connection id — never in connections.json.
export const StoredKanbanConnectionSchema = z.object({
  id: z.string(),
  kind: KanbanSourceKindSchema,
  name: z.string(),
  // Instance base URL. NEVER hardcode gitlab.com / atlassian.net.
  baseUrl: z.string(),
  // OAuth application client id (public). Self-hosted GitLab / Jira Server require
  // the user to register an OAuth app on their instance and supply this.
  oauthClientId: z.string().nullable().optional(),
  // True once the daemon holds a usable token (pasted PAT or completed OAuth).
  authConnected: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredKanbanConnection = z.infer<typeof StoredKanbanConnectionSchema>;

// ---------------------------------------------------------------------------
// Service input shapes (not wire schemas)
// ---------------------------------------------------------------------------

export interface CreateKanbanCardInput {
  title: string;
  url?: string | null;
  status?: KanbanStatus;
  theme?: string;
  source?: KanbanCardSource;
  externalId?: string | null;
  labels?: string[];
  assignee?: string | null;
  priority?: KanbanPriority | null;
  trigger?: KanbanCardTrigger;
  metadata?: Record<string, unknown>;
}

export interface UpdateKanbanCardInput {
  id: string;
  title?: string;
  url?: string | null;
  status?: KanbanStatus;
  theme?: string;
  order?: number;
  labels?: string[];
  assignee?: string | null;
  priority?: KanbanPriority | null;
  trigger?: KanbanCardTrigger | null;
  metadata?: Record<string, unknown>;
}

export interface MoveKanbanCardInput {
  id: string;
  status: KanbanStatus;
  order?: number;
}

export interface CreateKanbanSourceInput {
  kind: KanbanSourceKind;
  name: string;
  query: string;
  connectionId?: string | null;
  baseUrl?: string;
  enabled?: boolean;
  statusMap?: Record<string, KanbanStatus>;
  pollEverySec?: number;
  auth?: KanbanSourceAuth;
}

export interface UpdateKanbanSourceInput {
  id: string;
  name?: string;
  query?: string;
  connectionId?: string | null;
  baseUrl?: string;
  enabled?: boolean;
  statusMap?: Record<string, KanbanStatus> | null;
  pollEverySec?: number;
  auth?: KanbanSourceAuth | null;
}

export interface CreateKanbanConnectionInput {
  kind: KanbanSourceKind;
  name: string;
  baseUrl: string;
  oauthClientId?: string | null;
  // Secret material passed on create/update. The daemon writes these to
  // kanban/secrets.json keyed by connection id and never echoes them back.
  oauthClientSecret?: string | null;
  tokenValue?: string | null;
}

export interface UpdateKanbanConnectionInput {
  id: string;
  name?: string;
  baseUrl?: string;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  tokenValue?: string | null;
}
