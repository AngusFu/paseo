# Kanban board

A global, single-board task Kanban layered on the same file-based JSON + Zod +
atomic-write substrate as [schedules](data-model.md). It mirrors the schedule
feature across all four layers (protocol → server → cli → app).

## Columns & status

Six fixed columns, one per status: `pending | wip | done | skip | fail | abort`.
The left→right column order is `KANBAN_STATUS_ORDER` in
`packages/protocol/src/kanban/types.ts` — app and CLI both import it so the board
renders identically everywhere. Status is a closed enum, never free text.

## Data model

File-based JSON under `$PASEO_HOME/kanban/` (no sqlite, ever):

- `kanban/cards/{kbc_xxxxxxxx}.json` — one file per card (`StoredKanbanCardSchema`).
- `kanban/sources.json` — all sync sources in one file (`StoredKanbanSourceSchema`).

Card identity:

- Manually-created cards get a generated `kbc_<hex>` id and `source.kind = "manual"`.
- Synced cards are keyed by `(source.kind, externalId)` — e.g. `jira:PROJ-123`,
  `gitlab:<projectId>!<mrIid>`. Re-syncing upserts (update, never duplicate).
- `sourceId` (optional, added post-v1): the `StoredKanbanSource.id` that last
  synced the card. Backfilled naturally on next sync — no migration — so a
  multi-source-per-kind setup (two Jira sources, say) can attribute a card to
  its exact source instead of guessing by kind (see `resolveSourceForCard` in
  `server/kanban/card-context.ts`, used by both card-detail fetch and Jira
  write-back).

`theme` is `"jira" | "gitlab-mr" | "#RRGGBB"`; the render layer resolves it to an
icon + accent colour, falling back to default grey for anything unrecognized.

## Sync (jira / gitlab, poll-based v1)

`packages/server/src/server/kanban/sync.ts` pulls from the source's own
`baseUrl` — never a hardcoded host, so Jira Cloud, Jira Server/DC, and self-hosted
GitLab all work:

- Jira: `GET {baseUrl}/rest/api/2/search?jql=<query>` (Bearer token).
- GitLab: `GET {baseUrl}/api/v4/merge_requests?<query>` (`PRIVATE-TOKEN` header).

Each result maps to an upsert payload with a default external-status → column map
(overridable per source via `statusMap`). Credentials are resolved from
`process.env[auth.credentialRef]` in v1 — a real OAuth / secret-store flow is a
follow-up (see the `COMPAT`/TODO note in `sync.ts`).

Jira/GitLab pagination is capped at `MAX_SYNC_PAGES` (20 pages) as a safety net
against a runaway query. Hitting the cap with more pages still pending isn't a
hard failure — the cards already fetched still upsert — but it writes a
truncation warning into the source's `lastSyncError` (same field a real sync
failure uses) and logs a `logger.warn`, so a silently-incomplete board is at
least visible instead of quietly missing cards.

**Conflict rule:** `statusPinnedByUser` is set `true` only when a move
_actually_ changes the card's column/status — an in-column reorder (same
target, explicit `order`) does not pin. Once pinned, subsequent syncs update
title/url/theme/labels/metadata but leave `status`/`columnId` alone. Unpinned
cards follow the status map. A real Jira write-back transition (see below)
never sets this pin — Jira is authoritative once the transition round-trips,
so there's nothing for a later sync to diverge from.

## Drag / column change

- Web: real pointer drag (gesture-handler Pan + reanimated); dropping on another
  column fires the move mutation with an optimistic status update.
- Native (iOS/Android): drag is disabled; long-pressing a card opens a status
  picker sheet listing the six columns. This is the accepted v1 fallback so touch
  always has a way to change a card's column.

Both paths call `kanban.card.move.request` (see the Conflict rule above for when
this pins `statusPinnedByUser`).

## Multi-tab views (Overview / Jira / GitLab)

The board screen is a tab host: **Overview** (all cards, all kinds, including
manual — the pre-multi-tab cross-source board) plus one tab per source **kind**
actually present on the board (`KANBAN_SOURCE_KIND_ORDER` fixes the tab order so
tabs don't reorder as sources come and go). Manual cards have no kind and only
ever show in Overview.

Each tab's board component is resolved by source kind through
`resolveKanbanSourceView` (`app/src/components/kanban/kanban-source-view-registry.tsx`)
— a kind with no registered view (or Overview itself) falls back to the plain
`KanbanBoard`. Registered today: `jira` → `KanbanJiraBoard`, `gitlab` →
`KanbanGitlabBoard`, both built on the shared `KanbanStatusBoard`.

The Jira/GitLab tabs render lanes from the tracker's **real** status (e.g. Jira's
exact status name like "Pending Code Review", not Paseo's six generic buckets),
read off the card's raw `metadata` blob that sync already stores (`fields.status`
for Jira). Lanes are derived per-render from whatever statuses are actually
present — an unused status never gets an empty lane; a card synced before this
metadata existed falls back to a lane named after its legacy `KanbanStatus` so
nothing silently disappears. **Drag is currently disabled in these real-status
views** (`dragEnabled={false}`) — a real-status lane has no fixed mapping back to
one of Paseo's columns to move the card into, so offering a drag that silently
does nothing (or worse, transitions the wrong way) would be worse than no drag;
the Jira tab's real cross-lane move now goes through the write-back
`kanban.card.transition` RPC below instead once the app wires it up.

## Jira write-back

Real writes back to Jira — not just the one-way sync above — behind
`server_info.features.kanbanWriteBack` (`COMPAT(kanbanWriteBack)` marks the
cleanup site). Implemented in `server/kanban/writeback.ts`
(`KanbanCardWriteBackService`); every RPC below rejects a non-`jira` card with
an explicit error rather than silently no-op'ing.

- `kanban.card.list_transitions.request` `{cardId}` → the issue's **legal**
  transitions right now (`GET .../issue/{key}/transitions`), each
  `{id, name, toStatusName?}`. Not cached — Jira workflow transitions depend on
  the issue's live state.
- `kanban.card.transition.request` `{cardId, transitionId}` → executes the
  transition (`POST .../transitions`), re-fetches the issue's new status, maps
  it through the source's `columnMap`/`statusMap` (same `resolveColumnForSync`
  sync.ts already uses), and writes the result onto the local card via
  `KanbanStore.applyExternalTransition` — which, unlike `moveCard`/`updateCard`,
  **never sets `statusPinnedByUser`** (see the Conflict rule above).
- `kanban.card.add_comment.request` `{cardId, body}` → posts a comment
  (`POST .../comment`). Jira Cloud (v3 API) requires the body as ADF; Server/DC
  (v2 API) takes a plain string — same Cloud/Server detection card-detail
  already uses (`connection?.email` present ⇒ Cloud).
- Assignee/priority write-back is not implemented — Jira assignee requires an
  assignable-user search-and-pick flow first (a free-text name can't be PUT
  directly), a bigger unit of work than transition/comment; left for a
  follow-up if needed.

`server/kanban/card-context.ts` holds the shared "cardId → {source, connection,
baseUrl, token}" resolution both card-detail fetch and write-back use (extracted
from what used to be a private copy in `detail.ts` alone).

## Protocol

New dotted-namespace RPCs (`docs/rpc-namespacing.md`): `kanban.card.*` and
`kanban.source.*`, each a `.request`/`.response` pair. All fields are additive and
optional; wire schemas are pure structural declarations (discriminated unions for
`source`/`auth`, no `transform`/`catch`/`preprocess`). Gated behind
`server_info.features.kanban` — `COMPAT(kanban)` marks the cleanup site. Later
capabilities layer on their own flags the same way: `kanbanColumns`,
`kanbanCardDetail`, `kanbanWriteBack` (Jira write-back RPCs above).

## Workflow auto-trigger (source rules)

New cards from sync can automatically enqueue a workflow run. See
[workflow.md](workflow.md) for storage, RPCs, and concurrency.

- Rules live in `$PASEO_HOME/workflows/rules.json` (`kanban.rule.*` RPCs).
- Each rule binds a Kanban **source** to a workflow definition, with optional
  filter (`labelsAny`, `titleRegex`, `projectKey`) and an enabled flag.
- On sync, when `upsertCardBySource` **creates** a card (first insert for
  `(source.kind, externalId)`), matching enabled rules enqueue runs.
- Re-sync updates do not re-trigger. Card-level `trigger` / status-change
  auto-loop remains a separate follow-up (still not executed).
- App UX: edit-source sheet has two tabs — **Source** (query/connection/…) and
  **Workflow rules** (`KanbanWorkflowRulesSection`). Rules mutate immediately;
  the rules tab footer is Close only (no Save). Create-source has no rules tab
  until the source exists.

## Card-level trigger (reserved, not executed)

- **`trigger` field on the card** (`{ onStatus, target: ScheduleTarget }`,
  optional): "when this card enters `onStatus`, run this target." Still stored
  only — not consumed. Distinct from source-level workflow rules above.
