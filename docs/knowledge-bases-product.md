# Knowledge bases - Product plan

Product source of truth for the dedicated `Knowledge bases` hub. This doc defines the user-facing product contract for create, browse, manage, detail, search, edit, workspace mount relationship, and the Settings redirect. Desktop-specific interaction notes and RPC gaps live in [knowledge-bases-desktop.md](./knowledge-bases-desktop.md). Content-plane and ACL semantics live in [virtual-fs-hooks.md](./virtual-fs-hooks.md). Terminology is locked by [glossary.md](./glossary.md).

English copy candidates below are intentional product copy, not final localization strings. zh-CN can follow after the English contract stabilizes.

## Problem

Paseo now has daemon-scoped Knowledge bases and workspace mounts, but the primary UI still starts from Host settings and mount sheets. That is enough for setup, but not enough for a durable product surface:

- users need one obvious home for Knowledge bases, parallel to Workflows and Schedules
- users need two authoring starts: import existing docs once, or create an empty Knowledge base and write inside it
- users need to understand the relationship between a host-wide Knowledge base and the workspaces that mount it
- users need in-product browse, search, and page editing so "update the Knowledge base" does not mean "go back to disk and re-import"

The dedicated hub solves this by making Knowledge bases a first-class host capability with a clear lifecycle:

```text
Create or import on the host
  -> browse and search inside one Knowledge base
  -> edit pages inside the Knowledge base
  -> mount into one or more workspaces
  -> agents read /paseo-vfs/<mountSlug>/... only where mounted
```

## Who it is for

- solo developers who want reusable runbooks, project notes, prompts, and references across workspaces
- small teams or power users who keep host-local corpora such as "company runbooks" or "product FAQ"
- users who want to start from nothing and write KB pages directly in Paseo, not only import from disk

## Success metrics

Lightweight product success signals for v1:

- users can discover Knowledge bases from the left rail without being taught a Host-settings path
- users can complete both first-run paths: `Import` and `Empty`
- users understand that Knowledge bases are host-scoped, mounts are workspace-scoped, and agents are read-only
- users can update a Knowledge base by editing pages in-product instead of asking for disk sync
- support questions shift away from "where do I manage Knowledge bases?" and "why did my folder not re-sync?"

## Product locks

These are product decisions, not open questions:

- The primary entry is the dedicated left-rail `Knowledge bases` hub.
- `Settings -> Host -> Knowledge bases` is redirect-only. It must not host a second manage UI.
- A Knowledge base is daemon-scoped. A mount is workspace-scoped. Agents only see mounted trees under `/paseo-vfs/<mountSlug>/...`.
- Creation has two first-class modes: `Empty` and `Import`.
- There is no watched-folder or disk-sync product path. Import is one-shot.
- Updating an existing Knowledge base means editing pages inside the Knowledge base, not re-importing into the same KB.
- Re-import is only a "new snapshot as a new Knowledge base" path.
- Capability gating is single-source: `server_info.features.knowledgeBases`. No degraded fallback implementation.
- Product CLI remains `paseo kb` only.

## Information architecture

### Navigation model

| Surface                                        | Scope                     | Owns                                                                  | Does not own                    |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| `Knowledge bases` hub (`/knowledge-bases`)     | One selected host         | List, create, import, export, open detail, delete                     | Workspace mount mutations       |
| Knowledge base detail (`/knowledge-bases/:id`) | One selected host, one KB | Browse pages, search pages, page edit, page add/remove, usage summary | Cross-workspace mount editing   |
| `Settings -> Host -> Knowledge bases`          | One host                  | Redirect into the hub + host Embeddings config (vector search/import) | KB list/import/delete manage UI |
| `New workspace` mount picker                   | One workspace draft       | Initial mount selection                                               | KB content                      |
| `Mount knowledge bases` sheet                  | One existing workspace    | Add/remove mounts                                                     | KB content, KB delete           |
| Agent `/paseo-vfs` view                        | One workspace             | Read mounted KBs                                                      | Registry, edits, mount changes  |

### Route ownership

| Route                                       | Purpose                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `/knowledge-bases`                          | Dedicated hub list for the currently selected host         |
| `/knowledge-bases/:id`                      | Detail for one Knowledge base                              |
| `/settings/hosts/:serverId/knowledge-bases` | Redirect surface with a single CTA into `/knowledge-bases` |

### Host scope

The hub is globally reachable from the left rail, but its data is never cross-host.

- if the user has one host, the hub opens that host directly
- if the user has multiple hosts, the hub shows a host picker in the toolbar
- the selected host controls the entire list/detail context
- the user never sees a merged multi-host Knowledge base catalog

## User journeys

### 1. First import

Goal: bring an existing folder or corpus package into Paseo once and start using it immediately.

1. User opens `Knowledge bases`.
2. Empty state or toolbar CTA offers `New knowledge base`.
3. User chooses `Import`.
4. User picks `Folder` or `Package`.
5. Desktop + local host: user chooses a directory on the daemon host.
6. User enters `Slug` and optional `Name`.
7. On submit, Paseo creates a new Knowledge base, imports text, builds search data, and lands the user back in the hub or directly in detail.
8. The imported Knowledge base is now the source of truth. Paseo does not watch the original folder.

Copy candidates:

- Title: `Import knowledge base`
- Hint: `One-shot import. The Knowledge base becomes the source of truth. Disk path is not watched.`
- Success toast: `Imported {{slug}}`

### 2. Empty create + first page

Goal: let users start a Knowledge base from zero without preparing a folder on disk.

1. User opens `Knowledge bases`.
2. User chooses `New knowledge base`.
3. User chooses `Empty`.
4. User enters `Slug` and optional `Name`.
5. Paseo creates an empty Knowledge base and opens its detail screen.
6. Detail empty state explains there are no pages yet and offers `Add first page`.
7. User creates a page path and writes the first page content in the editor.

Copy candidates:

- Empty-mode hint: `Creates an empty Knowledge base. Add pages later from the detail screen.`
- Detail empty title: `This Knowledge base has no pages yet`
- Detail empty body: `Add a first page to start building this Knowledge base.`
- CTA: `Add first page`

### 3. Browse and search

Goal: quickly inspect what is already in a Knowledge base.

1. User opens a Knowledge base from the hub list.
2. Detail screen shows page tree, preview pane, and in-KB search entry.
3. User can browse by tree or search by query.
4. Selecting a page or search result opens preview and reveals its place in the tree.

Copy candidates:

- Search placeholder: `Search this Knowledge base`
- Empty search results: `No pages matched "{{query}}".`

### 4. Edit page

Goal: maintain the Knowledge base in-product instead of syncing a source folder.

1. User opens a page in detail.
2. User enters edit mode from the preview pane.
3. User edits page content and, when needed, page path/title metadata.
4. User saves changes and returns to preview.
5. Search and tree refresh against the updated in-KB content.

Copy candidates:

- Edit CTA: `Edit page`
- Save CTA: `Save`
- Dirty guard: `Discard unsaved changes?`

### 5. Mount to workspace

Goal: connect a host-scoped Knowledge base to a workspace so agents can read it.

Primary mount flows remain workspace-owned:

- `New workspace` -> `Mount knowledge bases`
- Workspace kebab -> `Mount knowledge bases`

The hub and detail screen should explain this relationship clearly:

- detail shows mount usage summary such as `Mounted on 2 workspaces`
- detail can show a read-only list of mounted workspaces
- any CTA from detail should route the user toward workspace-owned mount management, not invent a hub-side global mount editor

### 6. Delete blocked

Goal: protect mounted Knowledge bases from accidental destructive actions.

1. User chooses `Delete` from the list row or detail menu.
2. Paseo checks whether the Knowledge base is mounted anywhere.
3. If mounted, deletion is refused.
4. Dialog explains that the user must unmount it from those workspaces first and lists the known usages.

Copy candidates:

- Title: `Still mounted`
- Body: `{{slug}} is still mounted on {{count}} workspace(s). Unmount it from those workspaces first.`
- Button: `OK`

## Screen contracts

### Hub list screen

Purpose: global home for Knowledge bases on one host.

#### Layout

- top app header title: `Knowledge bases`
- toolbar:
  - optional host picker when multiple hosts exist
  - primary CTA: `New knowledge base`
- main body:
  - loading / unsupported / no-host / empty / list states

#### States

| State                                | Contract                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| No host configured                   | Show `Add a host to manage Knowledge bases.`                                      |
| Host selected but capability missing | Show `Update the host to use Knowledge bases.`                                    |
| Loading                              | Use a loading state, not an empty state                                           |
| Empty catalog                        | Show create/import explanation and `New knowledge base` CTA                       |
| Loaded list                          | Show rows with name, slug, imported/embedded timing, and mount count if available |

#### Row contract

Each row should communicate identity and manage actions at a glance:

- primary label: `name` if present, otherwise `slug`
- secondary metadata: `slug`, `kbId` or other muted identity detail
- provenance/timing: import date, last embedded date
- usage summary when known: `Mounted on N workspace(s)` or `Not mounted`
- tap/click row opens detail
- overflow menu contains `Export` and `Delete`

#### Empty state copy

- Title: `No Knowledge bases yet`
- Body: `Create an empty Knowledge base or import a folder of text files.`
- Secondary line on non-Desktop or remote host: `Import and export path pickers require Desktop with a local host.`

#### Why the hub does not own mounting

The hub is host-scoped. Mounts are workspace-scoped. The hub may show usage, but it must not become a second place to mutate mounts across workspaces.

### New knowledge base sheet

Purpose: unify both creation starts in one product entry.

#### Modes

| Mode     | For                                     | Requires path picker?          | Landing state                                    |
| -------- | --------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `Empty`  | Start from zero and write in Paseo      | No                             | Open detail empty state                          |
| `Import` | Snapshot existing content into a new KB | Yes for folder/package picking | Return to hub or open detail with imported pages |

#### Shared fields

- `Slug` (required)
- `Name` (optional)

#### Import-only fields

- `Source`: `Folder` or `Package`
- directory picker / chosen path display

#### Validation and behavior

- `Slug` uses the standard Knowledge base slug rule
- `Name` defaults to slug when omitted
- import always creates a new Knowledge base
- the sheet copy must explicitly say that import is one-shot and not watched

### Detail screen

Purpose: the main surface for one Knowledge base after creation.

#### Layout contract

The detail screen owns four product jobs:

1. browse the page tree
2. preview the selected page
3. search within the current Knowledge base
4. enter page editing

Suggested information blocks:

- header:
  - back to list
  - KB name / slug
  - optional host indicator if needed
  - overflow menu with `Export` and `Delete`
- left or top navigation pane:
  - page tree
  - `New page` CTA
  - search entry
- main pane:
  - preview state or editor state
- relationship panel or summary:
  - mount usage count
  - list of mounted workspaces when available
  - explanatory copy: `Mounts are managed from workspaces.`

#### Page tree contract

- shows the Knowledge base's internal page hierarchy, not a live disk tree
- selecting a node opens preview
- empty Knowledge base shows no tree items and points to `Add first page`

#### Search contract

- scope: current Knowledge base only
- target: page titles/paths/content within that KB
- results show page title/path plus a short snippet
- selecting a result opens the page preview and reveals it in the tree
- no host-wide cross-KB search in v1

#### Mount relationship contract

The detail screen should make the host-vs-workspace model legible:

- `Mounted on 0 workspaces` means agents will not see it anywhere yet
- `Mounted on N workspaces` means it is currently visible to agents in those workspaces
- detail can show read-only usage rows such as workspace title and mount slug
- changing mounts remains outside this screen — no hub-side global mount editor

**Detail CTA contract (P2.1):**

- Prefer routing the user into workspace-owned mount management, not inventing a second editor on the hub.
- When the selected host has a **current or last workspace on that same host**, the CTA opens that workspace’s **Mount knowledge bases** sheet.
- Otherwise show a short hint/toast only (for example: pick a workspace on this host, then use Mount knowledge bases).
- Primary mount mutation paths remain: New Workspace mount picker, and workspace kebab → **Mount knowledge bases**.

### Editor contract

Purpose: maintain the Knowledge base in-product.

#### Editing scope

The editor supports:

- add page
- edit page content
- rename or move page path within the KB tree
- delete page

#### Editing model

- editing is in-KB; it does not patch the original import source on disk
- save writes back to the Knowledge base immediately
- cancel or back should guard against unsaved changes
- preview is the default resting state after save

#### Copy candidates

- `New page`
- `Edit page`
- `Page path`
- `Markdown`
- `Save`
- `Cancel`
- `Delete page`

## Create model

This model is locked and should be reused consistently across UI copy, CLI help, and support answers.

| User intent                                          | Product path                         | Result                                         | Not this                               |
| ---------------------------------------------------- | ------------------------------------ | ---------------------------------------------- | -------------------------------------- |
| I want a blank Knowledge base                        | `New knowledge base -> Empty`        | New empty KB, then create first page in detail | Import from a dummy folder             |
| I have docs on disk already                          | `New knowledge base -> Import`       | New KB snapshot from folder or package         | Mounting a live folder                 |
| My source folder changed and I want a fresh snapshot | Import again as a new Knowledge base | New KB with new identity                       | Replace content inside the existing KB |
| I want to fix or add a few pages                     | Edit pages inside the existing KB    | Same KB identity, updated content              | Re-import into the same KB             |

Product interpretation:

- `Import` is a snapshotting path.
- `Edit` is the maintenance path.
- "Re-import" means "create a new Knowledge base from a new snapshot", not "sync the same Knowledge base from disk again".

## Permissions, capability, and environment behavior

### Capability gate

Single product gate:

- `server_info.features.knowledgeBases === true` -> feature available
- otherwise show upgrade messaging only

There is no fallback feature path on older hosts.

### Environment matrix

| Context                 | Empty create                     | Import / export                    | UX contract                     |
| ----------------------- | -------------------------------- | ---------------------------------- | ------------------------------- |
| Desktop + local host    | Supported                        | Supported with directory pickers   | Full hub experience             |
| Desktop + remote host   | Supported                        | Do not fake a remote path text box | Show CLI hint for import/export |
| Browser web             | Supported when capability exists | Do not fake a path picker          | Show CLI hint for import/export |
| No host configured      | Not available                    | Not available                      | Prompt to add a host            |
| Host without capability | Not available                    | Not available                      | Prompt to update the host       |

### Copy for path-limited contexts

- Import hint: `Use Desktop to choose a folder on this host.`
- Remote/browser hint: `On this host, use: paseo kb import ...`
- Export hint: `On this host, use: paseo kb export {{slug}} --out <dir>`

## Non-goals for v1

- no watched-folder sync
- no "replace this KB from disk" action
- no project-owned Knowledge base catalog
- no cross-KB global search across the host
- no agent write access under `/paseo-vfs`
- no multimodal ingest product surface
- no version history, diff history, or collaborative editing
- no second Knowledge base **manage** UI inside Host settings (registry list/import/delete stay on the hub)
- Host settings may still host **infra** for Knowledge bases (Embeddings), which is not a manage UI

## Host Embeddings config

Vector import and in-KB vector search need an OpenAI-compatible embeddings backend. Config is **file + Host settings UI only** (`localTools.embeddings` in `$PASEO_HOME/config.json`). Environment variables do not control embeddings.

### Placement (locked)

`Settings -> Host -> Knowledge bases`:

1. existing redirect card into the hub (`Open Knowledge bases`, preserves `serverId`)
2. Embeddings settings card below (host-scoped)

### Fields

- Enabled
- Base URL (OpenAI-compatible `/v1` root, e.g. `http://127.0.0.1:11434/v1`)
- API key (optional for local Ollama; default may be `ollama`)
- Model id

### Actions

- Save → persist `localTools.embeddings` in `$PASEO_HOME/config.json` via daemon config
- Test → daemon calls embeddings API with a tiny probe
- Use Ollama (when daemon can reach Ollama on the host) → one-click fill Base URL + API key + preferred embedding model from detected tags (prefer names containing `embedding`, else a documented default such as `qwen3-embedding:0.6b`)

### Source of truth

Host settings UI reads/writes `localTools.embeddings` through `get_daemon_config` / `set_daemon_config`. Daemon and CLI load the same file config; there is no env override path. `enabled` must be explicitly `true` in file config.

### Failure UX

When import or vector search fails because embeddings are disabled/misconfigured, surface a clear error and deep-link to `Settings -> Host -> Knowledge bases` Embeddings section.

## Phased ship

Product phases are intentionally written in user-facing terms, then mapped to engineering waves. Hand-test closeout: [knowledge-bases-v1-acceptance.md](./knowledge-bases-v1-acceptance.md).

| Product phase | User-facing outcome                                                                                                                                 | Maps to engineering | Status                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------- |
| `P0`          | Dedicated hub exists, Settings redirects to it, users can create/import/browse the registry, and mount relationship is legible at the summary level | `K1`                | **Shipped** (2026-08-01)           |
| `P1`          | Users can open a Knowledge base, browse its page tree, preview pages, search within it, and understand mount usage from detail                      | `K2`                | **Shipped** (2026-08-01)           |
| `P2`          | Users can maintain the KB in-product: add first page, add/edit/delete pages, and keep content fresh without disk re-import                          | `K3`                | **Shipped** (2026-08-01)           |
| `P2.1`        | Detail mount-relationship CTA → same-host current/last workspace mounts sheet (else hint/toast); no hub-side global mount editor                    | follow-on to `K2`   | Shipping in parallel with closeout |
| `P3`          | Host Embeddings settings on Knowledge bases settings page (enable/URL/key/model, Use Ollama, Test); file+UI only (no env control)                   | `E1`+`E2`           | **In progress**                    |

### P0 scope

- left-rail `Knowledge bases` entry
- host-scoped hub with host picker where needed
- `Settings -> Host -> Knowledge bases` redirect into the hub (Embeddings config added in `P3`)
- list states: no host, unsupported, loading, empty, loaded
- `New knowledge base` sheet with `Empty` and `Import`
- export and delete from the hub
- delete-blocked dialog with workspace usages
- row/detail navigation contract established

### P1 scope

- real detail screen
- page tree
- preview
- in-KB search
- usage summary: `Mounted on N workspaces`
- read-only usage list and clear copy that mount mutations are workspace-owned

### P2 scope

- empty-KB first page flow
- add page anywhere in the tree
- edit page content
- rename/move page path
- delete page
- unsaved-change guard

## Engineering alignment notes

These are the main product clarifications versus a simple K1/K2/K3 reading:

1. `Settings -> Host -> Knowledge bases` is not a second Knowledge base **manage** surface (no list/import/delete there). It stays a hub redirect, plus host Embeddings infra config (`P3`).
2. `Empty` is not a nice-to-have. It is a first-class creation path and part of the base product contract.
3. K2 should include mount relationship visibility inside detail, not just tree/search/preview in isolation.
4. K3 is not "optional authoring later". It is the committed maintenance path for imported Knowledge bases.
5. Global cross-KB host search is intentionally not in the first three phases. Search is scoped to the current Knowledge base.

## Open product questions

No blocking product questions at this time.
