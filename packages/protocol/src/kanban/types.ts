import { z } from "zod";
import { ScheduleTargetSchema } from "../schedule/types.js";

// The six fixed Kanban columns. Column order (left → right) lives in
// KANBAN_STATUS_ORDER; the enum itself is order-agnostic.
export const KanbanStatusSchema = z.enum(["pending", "wip", "done", "skip", "fail", "abort"]);
export type KanbanStatus = z.infer<typeof KanbanStatusSchema>;

// Board column order (left → right). App and CLI share this constant so the
// six columns render identically everywhere.
export const KANBAN_STATUS_ORDER = ["pending", "wip", "done", "skip", "fail", "abort"] as const;

// A user-configurable board column (Jira-style). `legacyStatus` is the fixed
// KanbanStatus a pre-columns client sees for cards in this column, so the six
// hardcoded columns keep rendering correctly on old clients regardless of how
// many real columns exist.
export const KanbanColumnSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  // Float sort position, ascending. Same reinsertion-headroom rationale as
  // StoredKanbanCard.order.
  order: z.number(),
  hidden: z.boolean().default(false),
  legacyStatus: KanbanStatusSchema,
});
export type KanbanColumn = z.infer<typeof KanbanColumnSchema>;

// A status name reported by the external tracker itself (Jira status / GitLab
// MR state), for a future column-mapping UI. `category` is the provider's
// own bucket key when it has one (Jira statusCategory.key: "new" |
// "indeterminate" | "done"; GitLab uses its state name directly), null when
// the provider doesn't report one.
export const KanbanExternalStatusSchema = z.object({
  name: z.string(),
  category: z.string().nullable(),
});
export type KanbanExternalStatus = z.infer<typeof KanbanExternalStatusSchema>;

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
  // The board column this card sits in. Optional for back-compat with cards
  // written before columns existed; the store backfills it from `status` via
  // the first column whose legacyStatus matches (see KanbanStore migration).
  // `status` stays authoritative for old clients and is always kept in sync
  // with columnId's legacyStatus.
  columnId: z.string().optional(),
  // "jira" | "gitlab-mr" | "#RRGGBB". Render layer resolves to {icon, color};
  // an unrecognized value falls back to the default grey accent.
  theme: z.string(),
  source: KanbanCardSourceSchema,
  // (source.kind, externalId) idempotency key, e.g. "jira:PROJ-123". null for manual cards.
  externalId: z.string().nullable(),
  // The StoredKanbanSource.id that synced this card, when known. Lets a
  // multi-source-per-kind setup (two Jira sources, say) attribute a card to
  // its exact source instead of guessing by kind — see resolveSourceForCard
  // in card-context.ts, which this backfills over time as it stays optional
  // for cards synced before this field existed (never migrated in bulk).
  sourceId: z.string().optional(),
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
  // The tracker's OWN created/updated timestamps (ISO), distinct from the
  // Paseo-local createdAt/updatedAt below (which mark first-sync / last-write
  // and get bumped on every poll, so they can't drive a "recent activity"
  // filter). Populated by source sync; null/absent for manual cards.
  sourceCreatedAt: z.string().nullable().optional(),
  sourceUpdatedAt: z.string().nullable().optional(),
  // GitLab MR only: true when the MR has unresolved blocking discussion
  // threads (from `blocking_discussions_resolved === false`). Drives the
  // card's attention red dot. Absent for jira/manual cards.
  hasUnresolvedThreads: z.boolean().optional(),
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
  // built-in default map in the sync mapper. Superseded by columnMap for new
  // configuration, kept for existing sources and as a fallback.
  statusMap: z.record(z.string(), KanbanStatusSchema).optional(),
  // externalStatus → columnId override table. Takes priority over statusMap.
  // Lets sync target a specific user-created column instead of only the
  // fixed six legacy statuses.
  columnMap: z.record(z.string(), z.string()).optional(),
  // Mustache-style ({{var}}) dispatch-prompt template for cards from this
  // source. See renderPromptTemplate (packages/app/src/utils) for the
  // interpolation and buildDispatchPlan for the variable set.
  promptTemplate: z.string().optional(),
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
  // Jira Cloud account email. Jira Cloud REST auth is HTTP Basic with
  // base64(email:apiToken), so the email is required alongside the API token.
  // Unused for GitLab and Jira Server/DC (which use Bearer PATs).
  email: z.string().nullable().optional(),
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
  // When set, takes priority over `status` — the card moves to this column
  // and `status` is derived from the column's legacyStatus. Old clients that
  // only send `status` still work: the store finds the first column whose
  // legacyStatus matches.
  columnId?: string;
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
  columnMap?: Record<string, string>;
  promptTemplate?: string;
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
  columnMap?: Record<string, string> | null;
  promptTemplate?: string | null;
  pollEverySec?: number;
  auth?: KanbanSourceAuth | null;
}

export interface CreateKanbanConnectionInput {
  kind: KanbanSourceKind;
  name: string;
  baseUrl: string;
  email?: string | null;
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
  email?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  tokenValue?: string | null;
}

export interface CreateKanbanColumnInput {
  title: string;
  legacyStatus: KanbanStatus;
  order?: number;
  hidden?: boolean;
}

export interface UpdateKanbanColumnInput {
  id: string;
  title?: string;
  hidden?: boolean;
  legacyStatus?: KanbanStatus;
}

export interface ReorderKanbanColumnInput {
  id: string;
  order: number;
}

export interface DeleteKanbanColumnInput {
  id: string;
  moveCardsToColumnId: string;
}

// ---------------------------------------------------------------------------
// Card detail (on-demand fetch from the external tracker, not cached in
// StoredKanbanCard). Normalizes Jira issues and GitLab merge requests to one
// shape; fields are loosely typed (nullable/optional) because the two
// sources don't report the same set of metadata.
// ---------------------------------------------------------------------------

export const KanbanCardDetailCommentSchema = z.object({
  author: z.string().nullable(),
  createdAt: z.string().nullable(),
  bodyMarkdown: z.string(),
});
export type KanbanCardDetailComment = z.infer<typeof KanbanCardDetailCommentSchema>;

// A Jira attachment surfaced through the daemon's own attachment proxy
// (see kanban/attachment-token-store.ts) rather than the tracker's
// authenticated download URL directly — the client never sees Jira
// credentials or the raw Jira URL.
export const KanbanCardDetailAttachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  // e.g. "/kanban/attachment/<token>" — the client joins this with the
  // daemon base URL itself.
  proxyPath: z.string(),
});
export type KanbanCardDetailAttachment = z.infer<typeof KanbanCardDetailAttachmentSchema>;

export const KanbanCardDetailSchema = z.object({
  title: z.string(),
  url: z.string().nullable(),
  // Raw tracker status name (e.g. "In Code Review"), not a KanbanStatus.
  externalStatus: z.string().nullable(),
  assignee: z.string().nullable(),
  reporter: z.string().nullable(),
  labels: z.array(z.string()),
  priority: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  descriptionMarkdown: z.string().nullable(),
  // COMPAT(kanbanCommentLazyLoad): comments used to be inlined here. Kept
  // optional (never sent by a current daemon) so an old client's schema
  // expectations still parse a new daemon's response. Fetch comments via
  // kanban.card.comments.request instead; commentCount below is the summary
  // a new client renders before the user opens the comments list.
  comments: z.array(KanbanCardDetailCommentSchema).optional(),
  // Total comment count from the tracker, when cheaply available (Jira
  // reports it on the same paginated comments endpoint; GitLab would need an
  // extra request per note page, so it's left null there for now). Null also
  // covers manual cards, which have no external comment count.
  commentCount: z.number().nullable().optional(),
  attachments: z.array(KanbanCardDetailAttachmentSchema).optional(),
});
export type KanbanCardDetail = z.infer<typeof KanbanCardDetailSchema>;

// ---------------------------------------------------------------------------
// Jira write-back (kanban.card.list_transitions / .transition / .add_comment).
// Jira-only today — every RPC that takes these rejects non-jira cards with an
// explicit error rather than silently no-op'ing.
// ---------------------------------------------------------------------------

// One legal move out of an issue's CURRENT status, as Jira's workflow allows
// right now (not every status in the workflow — only the ones reachable from
// here). `toStatusName` is the raw tracker status name the transition lands
// on; absent when Jira didn't report a target (rare, but the API allows it).
export const KanbanCardTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  toStatusName: z.string().optional(),
});
export type KanbanCardTransition = z.infer<typeof KanbanCardTransitionSchema>;
