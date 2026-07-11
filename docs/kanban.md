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

**Conflict rule:** once a user drags a card between columns, `statusPinnedByUser`
is set `true`; subsequent syncs then update title/url/theme/labels/metadata but
leave `status` alone. Unpinned cards follow the status map.

## Drag / column change

- Web: real pointer drag (gesture-handler Pan + reanimated); dropping on another
  column fires the move mutation with an optimistic status update.
- Native (iOS/Android): drag is disabled; long-pressing a card opens a status
  picker sheet listing the six columns. This is the accepted v1 fallback so touch
  always has a way to change a card's column.

Both paths call `kanban.card.move.request`, which sets `statusPinnedByUser = true`.

## Protocol

New dotted-namespace RPCs (`docs/rpc-namespacing.md`): `kanban.card.*` and
`kanban.source.*`, each a `.request`/`.response` pair. All fields are additive and
optional; wire schemas are pure structural declarations (discriminated unions for
`source`/`auth`, no `transform`/`catch`/`preprocess`). Gated behind
`server_info.features.kanban` — `COMPAT(kanban)` marks the cleanup site.

## auto-loop hook (design detail D — NOT built here)

v1 only _produces_ the data an auto-loop engine would consume; it does not run any
task flow. Two seams are reserved:

- **Status-change signal.** A card's status changing (drag or sync) is already
  observable via the existing card-change broadcast; the terminal auto-loop goal
  subscribes to it. v1 produces, does not consume.
- **`trigger` field on the card** (`{ onStatus, target: ScheduleTarget }`,
  optional): "when this card enters `onStatus`, run this target." v1 stores it and
  the CLI can write it, but nothing executes it. The terminal auto-loop engine
  will subscribe to status changes, read `trigger`, and call the existing schedule
  `command-runner` — no data-model change required then.

TODO(auto-loop): wire the consumer in a dedicated goal; the `ScheduleTarget`
execution primitives already exist in `packages/server/src/server/schedule/`.
