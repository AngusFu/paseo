# Knowledge bases v1 — hand-test acceptance

Short checkbox checklist for **P0–P2** against the product contract in [knowledge-bases-product.md](./knowledge-bases-product.md). Desktop placement notes: [knowledge-bases-desktop.md](./knowledge-bases-desktop.md).

Status: **P0–P2 shipped** (2026-08-01). Use this list for closeout / regression, not as a second product spec.

## Environment

Hand-test against **root checkout** dev:

```bash
# Terminal A — daemon on 6768 (checkout-local .dev/paseo-home)
env -u PASEO_HOME npm run dev:server

# Terminal B — Expo on 8081 → localhost:6768
env -u PASEO_HOME npm run dev:app
```

- Daemon: `127.0.0.1:6768`
- Expo: `http://localhost:8081`
- Prefer Desktop / Electron for Import/Export path pickers; Empty create and browse/edit work without them when capability is present.
- Capability required: `server_info.features.knowledgeBases === true`.

## Journeys

### 1. First import (P0)

- [ ] Left rail → **Knowledge bases** opens `/knowledge-bases` (host-scoped; host picker when multiple hosts).
- [ ] Empty or toolbar → **New knowledge base** → **Import**.
- [ ] Desktop + local host: pick Folder or Package, set Slug (+ optional Name).
- [ ] Submit creates a new KB (one-shot; disk path not watched); lands hub or detail with imported pages.
- [ ] Success feedback (toast or list refresh) for the new slug.

### 2. Empty + first page (P0 + P2)

- [ ] **New knowledge base** → **Empty** → Slug (+ optional Name); no path picker required.
- [ ] After create, detail opens with empty-state copy and **Add first page**.
- [ ] Create a page path, write Markdown, **Save**; tree shows the new page and preview is the resting state.

### 3. Browse / search (P1)

- [ ] Hub row opens `/knowledge-bases/:id`.
- [ ] Page tree browse selects a page → preview.
- [ ] In-KB search returns path/title + snippet; selecting a hit opens preview and reveals the page in the tree.
- [ ] Empty search shows no-match copy for the query.
- [ ] Detail shows mount usage summary (`Mounted on N workspace(s)` / not mounted).

### 4. Edit / rename / delete page + unsaved discard (P2)

- [ ] **Edit page** → change content → **Save** → preview updates; search/tree reflect new content.
- [ ] Rename or move page path within the KB; tree updates.
- [ ] **Delete page** removes that page only (KB remains).
- [ ] Dirty editor: navigate away / Cancel → **Discard unsaved changes?**; discard drops edits, keep returns to editor.

### 5. Mount relationship + detail CTA (P1 / P2.1)

Product contract: mounts stay workspace-owned. Hub/detail never host a global mount editor.

- [ ] Detail shows read-only usage (workspace title + mount slug when available) and copy that mounts are managed from workspaces.
- [ ] **CTA (P2.1, may ship in parallel):** from detail, when there is a **same-host** current or last workspace → opens that workspace’s **Mount knowledge bases** sheet.
- [ ] Same CTA when there is **no** same-host current/last workspace → hint/toast only (no fake mount UI on the hub).
- [ ] Primary mount mutations still work from New Workspace mount picker and workspace kebab → **Mount knowledge bases**.

### 6. Delete blocked while mounted (P0)

- [ ] Mount the KB on at least one workspace.
- [ ] Hub or detail **Delete** is refused; dialog lists known workspace usages and tells the user to unmount first.
- [ ] After unmounting everywhere, delete succeeds with destructive confirm.

### 7. Settings → Hub preserves `serverId` (P0)

- [ ] With multiple hosts (or a non-default host selected in Settings), open **Settings → Host → Knowledge bases**.
- [ ] Surface is redirect-only (no duplicate manage UI).
- [ ] **Open** / CTA lands on `/knowledge-bases?serverId=…` and the hub selects that host.

## Out of scope for this checklist

- Watched-folder sync, re-import into the same KB, cross-KB host search, agent writes under `/paseo-vfs`, D6 remember-last mount / Project suggested mounts — see product Non-goals and desktop Later phases.
