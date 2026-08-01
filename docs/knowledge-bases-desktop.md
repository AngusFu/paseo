# Knowledge bases — Desktop UX design

Low-fidelity Desktop / Host UX for daemon-scoped **Knowledge bases** and workspace **Knowledge base mounts**. Product semantics are locked in [virtual-fs-hooks.md](./virtual-fs-hooks.md); terminology in [glossary.md](./glossary.md). This page is the placement + interaction contract for UI — not React implementation.

Related: [forms.md](./forms.md), [design.md](./design.md), [rpc-namespacing.md](./rpc-namespacing.md), [expo-router.md](./expo-router.md).

## Goals

- Let a host operator **import / export / list / delete** Knowledge bases from Desktop (Host settings), without watching a folder or re-syncing disk.
- Let users **opt in** to mounts at New Workspace create time (default **empty**) and **add/remove mounts** later without recreating the workspace.
- Give agents a clear **read-only / empty** story for `/paseo-vfs` when nothing is mounted.
- Keep UI labels and copy aligned with glossary: **Knowledge base**, **Knowledge bases**, **Mount knowledge bases**. No "Docs library", "RAG corpus", "Vector store" as UI labels.
- Gate the feature on a single daemon capability; no degraded fallbacks on old hosts.

## Non-goals

- No Expo/React implementation in this design pass.
- No in-KB page authoring UI (add/edit/remove pages) in the first Desktop ship — CLI/corpus maintain stays later (see Phased UI delivery).
- No disk re-sync, folder watch, `create --root` bridge, or `paseo docs` shim.
- No Project-owned KB catalog; Project may later suggest mounts only.
- No mobile-first layout work (Desktop / Electron path first; compact can reuse the same Host section later).
- No multimodal ingest UI.
- No agent write path under `/paseo-vfs` (always read-only).

## Information architecture

| Surface                               | Sees                                                | Owns                                      | Does not own                             |
| ------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| **Host settings → Knowledge bases**   | Full daemon KB registry for that host               | Import, export, delete, list              | Mount list (workspace-owned)             |
| **New Workspace**                     | Host's KB catalog as mount candidates               | Initial mount selection (default none)    | Creating KB content                      |
| **Workspace → Mount knowledge bases** | Mounts for this workspace + host catalog            | Add / remove mounts; mount slug at attach | Corpus bytes; KB delete                  |
| **Agent**                             | Only mounted slugs under `/paseo-vfs/<mountSlug>/…` | Read via tools / `paseo kb`               | Registry, import/export, mount mutations |

```text
Host (daemon)
  └── Knowledge bases (registry + corpus)
        ▲ import / export / delete
        │
Workspace
  └── Knowledge base mounts → /paseo-vfs/<mountSlug>/…
        ▲ mount / unmount
        │
Agent (PASEO_WORKSPACE_ID)
  └── ls /paseo-vfs → mounted slugs only (read-only)
```

### Placement in existing Desktop navigation

| Screen                  | Where it lands                                                                                                                                                                 | Existing pattern to mirror                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1. Host manage          | New Host settings section slug `knowledge-bases` — route `buildSettingsHostSectionRoute(serverId, "knowledge-bases")` next to `workspaces` / `fastmcp` in `HOST_SECTION_ITEMS` | Host FastMCP / Workspaces pages; settings cards + sheets                            |
| 2. New Workspace mounts | Optional section on `new-workspace-screen` after Isolation / before submit — same class of create-time preference as Isolation                                                 | Form kit + load-state gating ([forms.md](./forms.md)); hide when capability missing |
| 3. Workspace mounts     | Sidebar workspace kebab → **"Mount knowledge bases"** → `AdaptiveModalSheet` (v1). No full Workspace Settings page required yet                                                | Schedule / Kanban sheets; footer rules from forms.md                                |
| 4. Agent empty / tip    | Skill / `AGENTS.md` guidance + optional workspace empty callout when mounts are empty; not a Host settings page                                                                | Sidebar callouts / setup panel tone — calm, factual                                 |

**Desktop-only affordances:** folder/package pickers and export destination use Electron `pickDirectory` (`packages/app/src/desktop/pick-directory.ts`). Non-Electron web: hide Import/Export path pickers or show "Update / use Desktop" — do not invent a remote path text box as a fallback product path.

---

## Screen 1 — Host: Knowledge bases manage

### Purpose

Daemon-scoped registry UI: import once into a self-contained corpus, export a text corpus package, delete when unmounted, browse list.

### Entry

- Settings → Host → **Knowledge bases** (`/settings/hosts/:serverId/knowledge-bases`).
- Capability gate: `server_info.features.knowledgeBases`. If false → single line: "Update the host to use Knowledge bases." (no partial UI).

### States

| State                          | UI                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connecting / loading           | Aggregate load gate — not "empty"                                                                                                                                                      |
| Empty (loaded, zero KBs)       | Short empty copy + primary **Import knowledge base**                                                                                                                                   |
| Loaded list                    | Rows: name, slug, id (muted), importedAt / lastEmbeddedAt, optional provenance note                                                                                                    |
| Import in progress             | Sheet stays open; indeterminate or chunk progress; Cancel only if daemon supports abort (v1: no abort — disable dismiss until done or failed)                                          |
| Import success                 | Close sheet; list refreshes; toast optional                                                                                                                                            |
| Import / export / delete error | Inline error on sheet or toast; list unchanged                                                                                                                                         |
| Delete blocked (still mounted) | Confirm disabled path: explain mounts remain; list workspace titles/ids if RPC returns them; CTA to open mount management is out of scope from Host — copy tells user to unmount first |

### Primary actions

1. **Import knowledge base** → Import sheet
2. Row overflow / detail: **Export**, **Delete**

### Dangerous actions

- **Delete** — footer left on edit/detail sheet (`variant="destructive"`), then `confirmDialog({ destructive: true })`. Daemon refuses if any workspace still mounts the KB.

### Import sheet (key interaction)

```text
┌─ Import knowledge base ─────────────────────────────┐
│ Source                                              │
│  (•) Folder of .md / .mdx / .txt                    │
│  ( ) Corpus package (manifest.json + pages/)        │
│                                                     │
│ [ Choose folder… ]   /Users/me/runbooks             │
│                                                     │
│ Slug *                                              │
│ [ company-runbooks______________ ]                  │
│ Name                                                │
│ [ Company runbooks______________ ]  (optional)      │
│                                                     │
│ One-shot import. The Knowledge base becomes the     │
│ source of truth. Disk path is not watched.          │
│                                                     │
│              [ Cancel ]  [ Import ]                 │
└─────────────────────────────────────────────────────┘
```

Notes:

- Source is a **directory** in both modes (folder of text files, or package root with `manifest.json` + `pages/`). Desktop directory picker covers both; UI copy distinguishes intent so users do not expect embeddings in packages.
- Slug: `^[a-z0-9][a-z0-9-]{0,62}$`, unique on daemon. Default name = slug if blank.
- Import always creates a **new** `kbId` (no replace-into-existing).
- No "watch folder" / "re-index from disk" control — omit entirely.

### Export interaction

```text
Row menu → Export
  → pickDirectory (export destination)
  → RPC export → writes paseo.kb.corpus/v1 (manifest + pages; no embeddings)
  → success toast with path
```

### Delete blocked (key interaction)

```text
┌─ Delete knowledge base? ────────────────────────────┐
│ company-runbooks is still mounted on 2 workspaces.  │
│ Unmount it from those workspaces first.             │
│                                                     │
│  • feature-auth (ws_…)   /paseo-vfs/runbooks        │
│  • ops-main (ws_…)       /paseo-vfs/runbooks        │
│                                                     │
│                         [ OK ]                      │
└─────────────────────────────────────────────────────┘
```

If not mounted: standard destructive confirm → delete.

### List wireframe

```text
Host settings › Knowledge bases
────────────────────────────────
[ Import knowledge base ]

┌ company-runbooks ────────────────────────── ⋯ ┐
│ Company runbooks · kb_a1b2…                   │
│ Imported Aug 1 · Embedded Aug 1               │
└───────────────────────────────────────────────┘
┌ product-faq ─────────────────────────────── ⋯ ┐
│ product-faq · kb_c3d4…                        │
│ Imported Jul 30 · Embedded never              │
└───────────────────────────────────────────────┘

⋯ menu: Export · Delete
```

### CLI correspondence

| UI     | CLI                                                            |
| ------ | -------------------------------------------------------------- |
| List   | `paseo kb list`                                                |
| Import | `paseo kb import --slug … --from <folder\|package> [--name …]` |
| Export | `paseo kb export <id-or-slug> --out <dir>`                     |
| Delete | `paseo kb delete <id-or-slug>`                                 |

---

## Screen 2 — New Workspace: mount picker

### Purpose

At create time, optionally attach Knowledge base mounts. **Default: none selected.** User opts in.

### Entry

- Global / project **New workspace** screen (`new-workspace-screen.tsx`).
- Section visible only when host capability `knowledgeBases` is true **and** KB list load reaches `loaded` (may be empty catalog — still show section with empty hint + link copy to Host Knowledge bases).
- Hidden entirely when capability missing (availability hierarchy from forms.md — not disabled-with-reason).

### States

| State                    | UI                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Capability missing       | Section omitted                                                                                        |
| Connecting / loading KBs | Section skeleton or pending resolution in form model                                                   |
| Loaded, zero KBs on host | "No Knowledge bases on this host." + muted pointer to Host → Knowledge bases (no auto-create)          |
| Loaded, catalog          | Multi-select checklist; none checked by default                                                        |
| Submit                   | Create workspace, then mount each selection (or batch set_mounts); mount failures surface after create |

### Primary actions

- Toggle Knowledge bases to mount.
- Optional per-row **mount slug** override (defaults to KB slug). Slug chosen here is **immutable** after create (change later = unmount + remount).

### Dangerous actions

- None on this screen (no delete KB).

### Wireframe

```text
New workspace
────────────────────────────────
Host        [ local ▾ ]
Project     [ better-paseo ▾ ]
Base / Ref  [ main ▾ ]
Isolation   (•) Worktree  ( ) Local

Mount knowledge bases          (optional)
┌─────────────────────────────────────────┐
│ [ ] company-runbooks                    │
│     → /paseo-vfs/company-runbooks       │
│ [ ] product-faq                         │
│     → /paseo-vfs/product-faq            │
│                                         │
│ None selected. Agents will see an empty │
│ /paseo-vfs until you mount later.       │
└─────────────────────────────────────────┘

                    [ Cancel ]  [ Create ]
```

Multi-select with optional slug field (disclosure when checked):

```text
│ [x] company-runbooks                    │
│     Mount slug [ company-runbooks____ ] │
│     → /paseo-vfs/company-runbooks       │
```

### CLI correspondence

| UI                        | CLI                                                       |
| ------------------------- | --------------------------------------------------------- |
| (after create) mount each | `paseo kb mount <id-or-slug> --workspace <id> [--slug …]` |
| Inspect                   | `paseo kb mounts --workspace <id>`                        |

Remember-last-selection as form preference: **later** (locked non-goal for v1).

---

## Screen 3 — Workspace: add / remove mounts

### Purpose

Change mounts without recreating the workspace. Mount slug set at attach time; immutable afterward.

### Entry

- Sidebar workspace kebab → **Mount knowledge bases** → sheet keyed by `workspaceId`.
- Future: same sheet from a Workspace settings surface if one is added; kebab is the v1 entry.

### States

| State                           | UI                                                                          |
| ------------------------------- | --------------------------------------------------------------------------- |
| Connecting / loading            | Load gate for mounts + host KB catalog                                      |
| Empty mounts                    | Empty copy + **Add mount**                                                  |
| Loaded mounts                   | List: mountSlug → KB name/slug; Unmount per row                             |
| Add mount                       | Sub-sheet or inline: pick unmounted KB + optional mount slug                |
| Slug conflict / already mounted | Validation error from daemon; stay on form                                  |
| Error                           | Toast / inline; do not leave inconsistent optimistic state without rollback |

### Primary actions

- **Add mount** (pick KB + mount slug).
- **Unmount** (removes workspace lens only; does not delete KB).

### Dangerous actions

- Unmount is reversible (remount) but agents lose `/paseo-vfs/<slug>` immediately — confirm if any agent is running in workspace (soft confirm OK; not destructive footer Delete pattern).

### Wireframe — mounts sheet

```text
┌─ Mount knowledge bases ─────────────────────────────┐
│ Workspace: feature-auth                             │
│                                                     │
│ Mounted                                             │
│  /paseo-vfs/company-runbooks   company-runbooks  [Unmount]
│                                                     │
│ [ Add mount ]                                       │
│                                                     │
│ Mount slugs cannot be renamed. To change a slug,    │
│ unmount and mount again.                            │
│                                                     │
│                              [ Done ]               │
└─────────────────────────────────────────────────────┘
```

### Wireframe — add mount

```text
┌─ Add mount ─────────────────────────────────────────┐
│ Knowledge base                                      │
│ [ company-runbooks ▾ ]                              │
│                                                     │
│ Mount slug                                          │
│ [ company-runbooks____ ]                            │
│ Agents see /paseo-vfs/company-runbooks              │
│                                                     │
│              [ Cancel ]  [ Mount ]                  │
└─────────────────────────────────────────────────────┘
```

Already-mounted KBs omitted from the picker (or shown disabled with "Already mounted").

### CLI correspondence

| UI          | CLI                                                       |
| ----------- | --------------------------------------------------------- |
| List mounts | `paseo kb mounts --workspace <id>`                        |
| Add         | `paseo kb mount <id-or-slug> --workspace <id> [--slug …]` |
| Remove      | `paseo kb unmount <mount-slug-or-kb-id> --workspace <id>` |

---

## Screen 4 — Agent: read-only tip / empty `/paseo-vfs`

### Purpose

Agents (and humans reading guidance) understand: virtual docs are **mounted Knowledge bases**, explore-only, not the live repo `docs/` tree.

### Entry

- Not a Host settings screen. Surfaces:
  1. **Skill / AGENTS guidance** injected for managed agents (primary).
  2. **Optional Desktop callout** in workspace when mounts length is 0 (dismissible) — points to Mount knowledge bases; does not invent KB content.
  3. Agent tool failure copy when exploring unmounted paths stays daemon/CLI-owned.

### States

| State          | Agent-visible behavior                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| No mounts      | `ls /paseo-vfs` → empty listing; tip: mount from Desktop or `paseo kb mount` |
| Has mounts     | `ls /paseo-vfs` → mount slugs; `ls /paseo-vfs/<slug>` → corpus tree          |
| Write attempt  | Deny (EROFS-equivalent) — tip: Knowledge bases are read-only for agents      |
| Unmounted path | Not found — tip: KB may exist on host but is not mounted here                |

### Wireframe — guidance blurb (copy contract)

```text
Knowledge bases (read-only)
  Mounted trees appear under /paseo-vfs/<mountSlug>/…
  Use ls / paseo kb ls, cat / paseo kb cat, grep / paseo kb grep.
  Writes are denied. Empty /paseo-vfs means this workspace has no
  Knowledge base mounts — ask the host to Mount knowledge bases.
```

### Wireframe — Desktop empty callout (optional)

```text
┌─────────────────────────────────────────────────────┐
│ No Knowledge base mounts                            │
│ Agents in this workspace see an empty /paseo-vfs.   │
│ [ Mount knowledge bases ]              [ Dismiss ]  │
└─────────────────────────────────────────────────────┘
```

### CLI correspondence

| Behavior                 | CLI                                                      |
| ------------------------ | -------------------------------------------------------- |
| List mounts              | `paseo kb mounts`                                        |
| Explore                  | `paseo kb ls\|cat\|grep\|search` under `/paseo-vfs/…`    |
| Dogfood without registry | `paseo kb --root …` / `--unsafe` (not Desktop KB manage) |

---

## RPC / capability gaps

CLI manage path already exists (`paseo kb import|export|list|delete|mount|unmount|mounts`). **Desktop needs WebSocket RPCs** — none exist in `packages/protocol` today for Knowledge bases. All below are **需新增** (names follow [rpc-namespacing.md](./rpc-namespacing.md)).

### Capability

```ts
// server_info.features.knowledgeBases
// COMPAT(knowledgeBases): added in v0.1.X, drop the gate when floor >= v0.1.X
knowledgeBases: z.boolean().optional();
```

Client: one gate; if false, hide Host section + New Workspace mount section + workspace mount menu item; show upgrade copy only where a nav entry would otherwise appear (Host section can show the upgrade line).

### Proposed RPCs (shapes only)

| RPC                                  | Direction     | Purpose                                   | Rough request / payload                                                                            |
| ------------------------------------ | ------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `knowledge_base.list.request`        | ↔ `.response` | Registry list for host                    | `{}` → `payload.knowledgeBases[]` (+ optional `mountedWorkspaceCount` or `mounts[]` for delete UX) |
| `knowledge_base.import.request`      | ↔ `.response` | One-shot import                           | `{ slug, name?, fromPath, sourceKind: "folder" \| "package" }` → `{ knowledgeBase, meta }`         |
| `knowledge_base.export.request`      | ↔ `.response` | Corpus package to directory               | `{ idOrSlug, outDir }` → `{ outDir, pageCount, format }`                                           |
| `knowledge_base.delete.request`      | ↔ `.response` | Delete if unmounted                       | `{ idOrSlug }` → `{ deleted }` or structured error `still_mounted` + workspace refs                |
| `knowledge_base.list_mounts.request` | ↔ `.response` | Mounts for one workspace                  | `{ workspaceId }` → `{ mounts: [{ knowledgeBaseId, mountSlug, slug?, name? }] }`                   |
| `knowledge_base.mount.request`       | ↔ `.response` | Attach                                    | `{ workspaceId, idOrSlug, mountSlug? }` → `{ mount }`                                              |
| `knowledge_base.unmount.request`     | ↔ `.response` | Detach                                    | `{ workspaceId, mountSlugOrKbId }` → `{ unmounted }`                                               |
| `knowledge_base.list_usages.request` | ↔ `.response` | **Optional** helper for delete-blocked UI | `{ idOrSlug }` → `{ workspaces: [{ workspaceId, title?, mountSlug }] }`                            |

Notes:

- Reuse server modules behind CLI (`docs-vfs/knowledge-base-*`); RPC is a thin session façade (`KnowledgeBaseService` + session dispatch).
- **Import long-RPC choice (D1):** (a) long-lived `knowledge_base.import.request` with a **10-minute** client timeout (`KNOWLEDGE_BASE_IMPORT_TIMEOUT_MS`). No `knowledge_base.import.progress` push in v1 — sheet stays open until response. Embeddings failures return a clear `payload.error` string (disabled config / HTTP embed failure).
- **`list_usages` shipped** in D1 (preferred for delete-blocked UX). `delete` also returns `code: "still_mounted"` + `workspaces[]` when refused.
- **Do not** add mounts onto `workspace.create.request` in v1 unless create+mount atomicity becomes a hard requirement — client sequences `workspace.create` then `knowledge_base.mount` (matches CLI). Optional later: `knowledge_base.set_mounts.request` replace-all for sheet Save.
- Wire schemas: pure structural Zod; no `.transform()` on WS schemas; optional fields for back-compat.
- Embeddings config remains daemon-side (`localTools.embeddings` / env); Desktop import surfaces a clear error if embeddings are required and unavailable — no Local Tools settings fold-in here.

### Desktop bridge (not RPC)

| Need                                              | Existing                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pick import folder / package dir / export out dir | `pickDirectory` via Electron dialog bridge                                                                                                                                  |
| Path validity on daemon host                      | Daemon resolves `fromPath` / `outDir` on **host filesystem** (local daemon). Remote hosts: same paths must exist on the daemon machine — copy must say "path on this host". |

---

## Open questions

1. ~~**Import progress UX**~~ — **Locked in D1:** blocking long RPC (10m timeout); no progress events. Sheet UX in D2 stays open until response.
2. **Remote host paths** — Import/Export path pickers are meaningful for local Desktop-managed daemons; for remote SSH-style hosts, path picking may be wrong. **Lock for v1:** enable Import/Export path UI only when `getIsElectron()` and host is local/desktop-managed; otherwise show CLI hint (`paseo kb import …` on that host).

Locked here (do not reopen without product change):

| Topic                    | Lock                                       |
| ------------------------ | ------------------------------------------ |
| Default mounts at create | Empty                                      |
| Slug immutability        | Change = unmount + remount                 |
| Delete while mounted     | Refuse                                     |
| CLI surface              | `paseo kb` only                            |
| Import / export          | One-shot / corpus package; no disk re-sync |
| First Workspace entry    | Kebab → Mount knowledge bases sheet        |

---

## Phased UI delivery

| Phase  | Scope                                                                                 | Status                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D0** | This design page + IA / RPC names                                                     | **Shipped**                                                                                                                                                                       |
| **D1** | Capability + RPCs (list/import/export/delete/mount/unmount/list_mounts + list_usages) | **Shipped** (2026-08-01) — `server_info.features.knowledgeBases`; client helpers on `DaemonClient.knowledgeBase*`                                                                 |
| **D2** | Host Knowledge bases section (list + import + export + delete)                        | **Shipped** (2026-08-01) — Host section slug `knowledge-bases`; `host-knowledge-bases-page.tsx`                                                                                   |
| **D3** | New Workspace mount picker (default empty) + Workspace Mount sheet                    | **Shipped** (2026-08-01) — `NewWorkspaceMountPicker` + kebab → `KnowledgeBaseMountsSheet`                                                                                         |
| **D4** | Agent guidance + optional empty `/paseo-vfs` callout                                  | **Shipped** (2026-08-01) — `KNOWLEDGE_BASES_AGENT_GUIDANCE` via daemonAppend + cursor-print AGENTS.md + `skills/paseo`; empty-mounts sidebar callout → `KnowledgeBaseMountsSheet` |
| **D5** | In-KB page browse/edit in Desktop (maintain corpus without re-import)                 | Later — depends on edit APIs in virtual-fs-hooks open questions                                                                                                                   |
| **D6** | Remember last mount selection; Project suggested mounts                               | Later                                                                                                                                                                             |

### D1 deviations / call notes for UI waves

| Topic           | Choice                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Import progress | No progress events; 10m correlated RPC timeout                                                                             |
| Capability      | `features.knowledgeBases === true` (optional boolean; absent = old host)                                                   |
| Client API      | `daemonClient.knowledgeBaseList/Import/Export/Delete/ListMounts/Mount/Unmount/ListUsages`                                  |
| Delete blocked  | Prefer `knowledgeBaseListUsages` before confirm; `knowledgeBaseDelete` also returns `code: "still_mounted"` + `workspaces` |
| Paths           | `fromPath` / `outDir` are **host filesystem** paths (local Desktop daemon)                                                 |
| Mount writes    | Daemon RPC mounts use Session `WorkspaceRegistry` (not a second writer on `workspaces.json`) so rename cannot drop mounts  |

Ship order intent: **D1 → D2 → D3 → D4**. D2 without D3 still lets power users mount via CLI; D3 without D2 is weak (nowhere to import). Prefer D2 and D3 in one Desktop milestone if capacity allows.

---

## Copy checklist (glossary)

Use exactly:

- Knowledge base / Knowledge bases
- Mount knowledge bases
- Mount slug (technical; show path preview `/paseo-vfs/<mountSlug>`)

Avoid as UI labels: Docs library, RAG corpus, Vector store, Docs VFS (unless debug), "sync folder", "re-index from disk".
