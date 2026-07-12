import { z } from "zod";
import {
  KanbanCardSourceSchema,
  KanbanCardTriggerSchema,
  KanbanColumnSchema,
  KanbanExternalStatusSchema,
  KanbanPrioritySchema,
  KanbanSourceAuthSchema,
  KanbanSourceKindSchema,
  KanbanStatusSchema,
  StoredKanbanCardSchema,
  StoredKanbanConnectionSchema,
  StoredKanbanSourceSchema,
} from "./types.js";

// New RPCs use dotted namespaces with direction suffixes (docs/rpc-namespacing.md).
// All fields new; nothing here narrows or removes an existing schema.

// ---------------------------------------------------------------------------
// Card requests
// ---------------------------------------------------------------------------

export const KanbanCardCreateRequestSchema = z.object({
  type: z.literal("kanban.card.create.request"),
  requestId: z.string(),
  title: z.string().min(1),
  url: z.string().nullable().optional(),
  status: KanbanStatusSchema.optional(),
  theme: z.string().optional(),
  source: KanbanCardSourceSchema.optional(),
  externalId: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),
  priority: KanbanPrioritySchema.nullable().optional(),
  trigger: KanbanCardTriggerSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const KanbanCardListRequestSchema = z.object({
  type: z.literal("kanban.card.list.request"),
  requestId: z.string(),
});

export const KanbanCardInspectRequestSchema = z.object({
  type: z.literal("kanban.card.inspect.request"),
  requestId: z.string(),
  cardId: z.string(),
});

export const KanbanCardUpdateRequestSchema = z.object({
  type: z.literal("kanban.card.update.request"),
  requestId: z.string(),
  cardId: z.string(),
  title: z.string().min(1).optional(),
  url: z.string().nullable().optional(),
  status: KanbanStatusSchema.optional(),
  theme: z.string().optional(),
  order: z.number().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),
  priority: KanbanPrioritySchema.nullable().optional(),
  trigger: KanbanCardTriggerSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Drag-to-column: sets status + pins statusPinnedByUser so sync won't override.
// columnId takes priority over status when both are present; status is kept
// for old clients that only know the six fixed statuses.
export const KanbanCardMoveRequestSchema = z.object({
  type: z.literal("kanban.card.move.request"),
  requestId: z.string(),
  cardId: z.string(),
  status: KanbanStatusSchema,
  columnId: z.string().optional(),
  order: z.number().optional(),
});

export const KanbanCardDeleteRequestSchema = z.object({
  type: z.literal("kanban.card.delete.request"),
  requestId: z.string(),
  cardId: z.string(),
});

// ---------------------------------------------------------------------------
// Source requests
// ---------------------------------------------------------------------------

export const KanbanSourceCreateRequestSchema = z.object({
  type: z.literal("kanban.source.create.request"),
  requestId: z.string(),
  kind: KanbanSourceKindSchema,
  name: z.string().min(1),
  query: z.string(),
  // Primary route: reference a reusable connection (instance + auth). baseUrl is
  // kept for the legacy CLI path that embeds an instance directly.
  connectionId: z.string().nullable().optional(),
  baseUrl: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  statusMap: z.record(z.string(), KanbanStatusSchema).optional(),
  columnMap: z.record(z.string(), z.string()).optional(),
  pollEverySec: z.number().int().positive().optional(),
  auth: KanbanSourceAuthSchema.optional(),
});

export const KanbanSourceListRequestSchema = z.object({
  type: z.literal("kanban.source.list.request"),
  requestId: z.string(),
});

export const KanbanSourceUpdateRequestSchema = z.object({
  type: z.literal("kanban.source.update.request"),
  requestId: z.string(),
  sourceId: z.string(),
  name: z.string().min(1).optional(),
  query: z.string().optional(),
  connectionId: z.string().nullable().optional(),
  baseUrl: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  statusMap: z.record(z.string(), KanbanStatusSchema).nullable().optional(),
  columnMap: z.record(z.string(), z.string()).nullable().optional(),
  pollEverySec: z.number().int().positive().optional(),
  auth: KanbanSourceAuthSchema.nullable().optional(),
});

export const KanbanSourceDeleteRequestSchema = z.object({
  type: z.literal("kanban.source.delete.request"),
  requestId: z.string(),
  sourceId: z.string(),
});

export const KanbanSourceSyncRequestSchema = z.object({
  type: z.literal("kanban.source.sync.request"),
  requestId: z.string(),
  sourceId: z.string(),
});

// Live-fetches the external tracker's status list for a column-mapping UI —
// not the cached statusMap/columnMap override tables. projectKey narrows a
// Jira lookup to one project's workflow; omitted, it queries every status
// visible to the credential instead.
export const KanbanSourceListExternalStatusesRequestSchema = z.object({
  type: z.literal("kanban.source.list_external_statuses.request"),
  requestId: z.string(),
  sourceId: z.string(),
  projectKey: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Connection requests (reusable instance + auth, managed in Settings)
// ---------------------------------------------------------------------------

export const KanbanConnectionCreateRequestSchema = z.object({
  type: z.literal("kanban.connection.create.request"),
  requestId: z.string(),
  kind: KanbanSourceKindSchema,
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  email: z.string().nullable().optional(),
  oauthClientId: z.string().nullable().optional(),
  oauthClientSecret: z.string().nullable().optional(),
  tokenValue: z.string().nullable().optional(),
});

export const KanbanConnectionListRequestSchema = z.object({
  type: z.literal("kanban.connection.list.request"),
  requestId: z.string(),
});

export const KanbanConnectionUpdateRequestSchema = z.object({
  type: z.literal("kanban.connection.update.request"),
  requestId: z.string(),
  connectionId: z.string(),
  name: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  email: z.string().nullable().optional(),
  oauthClientId: z.string().nullable().optional(),
  oauthClientSecret: z.string().nullable().optional(),
  tokenValue: z.string().nullable().optional(),
});

export const KanbanConnectionDeleteRequestSchema = z.object({
  type: z.literal("kanban.connection.delete.request"),
  requestId: z.string(),
  connectionId: z.string(),
});

// Begin an OAuth authorization-code flow for a connection. The daemon returns
// the provider authorize URL (built from the connection baseUrl + oauthClientId);
// the client opens it in a browser and the daemon's loopback callback route
// finishes the exchange and stores the tokens.
export const KanbanConnectionOauthStartRequestSchema = z.object({
  type: z.literal("kanban.connection.oauth.start.request"),
  requestId: z.string(),
  connectionId: z.string(),
});

// ---------------------------------------------------------------------------
// Column requests (Jira-style configurable board columns)
// ---------------------------------------------------------------------------

export const KanbanColumnListRequestSchema = z.object({
  type: z.literal("kanban.column.list.request"),
  requestId: z.string(),
});

export const KanbanColumnCreateRequestSchema = z.object({
  type: z.literal("kanban.column.create.request"),
  requestId: z.string(),
  title: z.string().min(1),
  legacyStatus: KanbanStatusSchema,
  order: z.number().optional(),
  hidden: z.boolean().optional(),
});

export const KanbanColumnUpdateRequestSchema = z.object({
  type: z.literal("kanban.column.update.request"),
  requestId: z.string(),
  columnId: z.string(),
  title: z.string().min(1).optional(),
  hidden: z.boolean().optional(),
  legacyStatus: KanbanStatusSchema.optional(),
});

export const KanbanColumnReorderRequestSchema = z.object({
  type: z.literal("kanban.column.reorder.request"),
  requestId: z.string(),
  columnId: z.string(),
  order: z.number(),
});

// Deleting a column requires moving its cards somewhere; the caller must name
// the destination column explicitly rather than the daemon guessing one.
export const KanbanColumnDeleteRequestSchema = z.object({
  type: z.literal("kanban.column.delete.request"),
  requestId: z.string(),
  columnId: z.string(),
  moveCardsToColumnId: z.string(),
});

// ---------------------------------------------------------------------------
// Card responses
// ---------------------------------------------------------------------------

export const KanbanCardCreateResponseSchema = z.object({
  type: z.literal("kanban.card.create.response"),
  payload: z.object({
    requestId: z.string(),
    card: StoredKanbanCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanCardListResponseSchema = z.object({
  type: z.literal("kanban.card.list.response"),
  payload: z.object({
    requestId: z.string(),
    cards: z.array(StoredKanbanCardSchema),
    error: z.string().nullable(),
  }),
});

export const KanbanCardInspectResponseSchema = z.object({
  type: z.literal("kanban.card.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    card: StoredKanbanCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanCardUpdateResponseSchema = z.object({
  type: z.literal("kanban.card.update.response"),
  payload: z.object({
    requestId: z.string(),
    card: StoredKanbanCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanCardMoveResponseSchema = z.object({
  type: z.literal("kanban.card.move.response"),
  payload: z.object({
    requestId: z.string(),
    card: StoredKanbanCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanCardDeleteResponseSchema = z.object({
  type: z.literal("kanban.card.delete.response"),
  payload: z.object({
    requestId: z.string(),
    cardId: z.string(),
    error: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Source responses
// ---------------------------------------------------------------------------

export const KanbanSourceCreateResponseSchema = z.object({
  type: z.literal("kanban.source.create.response"),
  payload: z.object({
    requestId: z.string(),
    source: StoredKanbanSourceSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanSourceListResponseSchema = z.object({
  type: z.literal("kanban.source.list.response"),
  payload: z.object({
    requestId: z.string(),
    sources: z.array(StoredKanbanSourceSchema),
    error: z.string().nullable(),
  }),
});

export const KanbanSourceUpdateResponseSchema = z.object({
  type: z.literal("kanban.source.update.response"),
  payload: z.object({
    requestId: z.string(),
    source: StoredKanbanSourceSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanSourceDeleteResponseSchema = z.object({
  type: z.literal("kanban.source.delete.response"),
  payload: z.object({
    requestId: z.string(),
    sourceId: z.string(),
    error: z.string().nullable(),
  }),
});

// sync returns the upserted cards plus the refreshed source (lastSyncAt/Error).
export const KanbanSourceSyncResponseSchema = z.object({
  type: z.literal("kanban.source.sync.response"),
  payload: z.object({
    requestId: z.string(),
    source: StoredKanbanSourceSchema.nullable(),
    cards: z.array(StoredKanbanCardSchema),
    upsertedCount: z.number().int(),
    error: z.string().nullable(),
  }),
});

export const KanbanSourceListExternalStatusesResponseSchema = z.object({
  type: z.literal("kanban.source.list_external_statuses.response"),
  payload: z.object({
    requestId: z.string(),
    statuses: z.array(KanbanExternalStatusSchema),
    error: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Connection responses
// ---------------------------------------------------------------------------

export const KanbanConnectionCreateResponseSchema = z.object({
  type: z.literal("kanban.connection.create.response"),
  payload: z.object({
    requestId: z.string(),
    connection: StoredKanbanConnectionSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanConnectionListResponseSchema = z.object({
  type: z.literal("kanban.connection.list.response"),
  payload: z.object({
    requestId: z.string(),
    connections: z.array(StoredKanbanConnectionSchema),
    error: z.string().nullable(),
  }),
});

export const KanbanConnectionUpdateResponseSchema = z.object({
  type: z.literal("kanban.connection.update.response"),
  payload: z.object({
    requestId: z.string(),
    connection: StoredKanbanConnectionSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanConnectionDeleteResponseSchema = z.object({
  type: z.literal("kanban.connection.delete.response"),
  payload: z.object({
    requestId: z.string(),
    connectionId: z.string(),
    error: z.string().nullable(),
  }),
});

export const KanbanConnectionOauthStartResponseSchema = z.object({
  type: z.literal("kanban.connection.oauth.start.response"),
  payload: z.object({
    requestId: z.string(),
    authorizeUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Column responses
// ---------------------------------------------------------------------------

export const KanbanColumnListResponseSchema = z.object({
  type: z.literal("kanban.column.list.response"),
  payload: z.object({
    requestId: z.string(),
    columns: z.array(KanbanColumnSchema),
    error: z.string().nullable(),
  }),
});

export const KanbanColumnCreateResponseSchema = z.object({
  type: z.literal("kanban.column.create.response"),
  payload: z.object({
    requestId: z.string(),
    column: KanbanColumnSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanColumnUpdateResponseSchema = z.object({
  type: z.literal("kanban.column.update.response"),
  payload: z.object({
    requestId: z.string(),
    column: KanbanColumnSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanColumnReorderResponseSchema = z.object({
  type: z.literal("kanban.column.reorder.response"),
  payload: z.object({
    requestId: z.string(),
    column: KanbanColumnSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanColumnDeleteResponseSchema = z.object({
  type: z.literal("kanban.column.delete.response"),
  payload: z.object({
    requestId: z.string(),
    columnId: z.string(),
    error: z.string().nullable(),
  }),
});
