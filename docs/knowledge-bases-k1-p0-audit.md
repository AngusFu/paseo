# Knowledge bases K1 vs P0 audit

P0–P2 shipped; hand-test closeout: [knowledge-bases-v1-acceptance.md](./knowledge-bases-v1-acceptance.md).

Baseline: current latest worktree as of 2026-08-01.

Scope: P0 / K1 surfaces only.

- Included: `/knowledge-bases` hub list, left-rail entry, host picker, `Settings -> Host -> Knowledge bases`, `New knowledge base` (`Empty | Import`), hub export/delete/usages, empty create without Desktop path picker.
- Out of scope: `/knowledge-bases/[id]` detail browse/search/edit work in progress. Any K2 detail implementation is not assessed here except where K1 surfaces depend on its landing behavior.

## Summary

K1 is mostly shipped on the intended surfaces: the left-rail hub exists, the Settings surface no longer hosts a duplicate manage UI, the hub has the expected loading/empty/unsupported states, and hub-side create/import/export/delete flows are wired.

The main P0 alignment gaps are:

1. ~~hub rows do not show mount usage summary~~ **fixed (K1-fix)** — rows show `Mounted on N workspace(s)` / `Not mounted` from `mountedWorkspaceCount`
2. ~~hub row identity hierarchy is reversed~~ **fixed (K1-fix)** — primary `name` (fallback `slug`), secondary `slug · id`
3. ~~host-specific entry from Settings drops host context~~ **fixed (K1-fix)** — Settings opens `/knowledge-bases?serverId=…` and the hub applies that host
4. `Empty` create stays on the hub instead of landing in detail as the product contract says — tracked as already done outside this audit baseline / K2b

## Gap table

| Product requirement                                                                                  | Status | Evidence path                                                                                                                                                     | Severity | Suggested owner |
| ---------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------- |
| Left-rail `Knowledge bases` entry exists and routes to the dedicated hub                             | pass   | `packages/app/src/components/left-sidebar.tsx`, `packages/app/src/app/_layout.tsx`, `packages/app/src/utils/host-routes.ts`                                       | none     | defer           |
| Hub is host-scoped and shows a host picker when multiple hosts exist                                 | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `packages/app/src/screens/settings/host-knowledge-bases-page.tsx`, `packages/app/src/utils/host-routes.ts` | none     | K1-fix          |
| `Settings -> Host -> Knowledge bases` is redirect-only and does not duplicate manage UI              | pass   | `packages/app/src/screens/settings/host-knowledge-bases-page.tsx`                                                                                                 | none     | defer           |
| Hub supports the expected list states: no host, unsupported, loading, empty, loaded                  | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `packages/app/src/knowledge-bases/use-knowledge-bases.ts`                                                  | none     | defer           |
| `New knowledge base` sheet offers both `Empty` and `Import` in one entry point                       | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`                                                                                                             | none     | defer           |
| Empty create works without a Desktop path picker when the capability is present                      | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `packages/app/src/knowledge-bases/resolve-knowledge-base-create.ts`                                        | none     | defer           |
| Empty create lands appropriately after submit                                                        | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `docs/knowledge-bases-product.md`                                                                          | none     | K2b             |
| Hub rows use the product identity hierarchy: primary `name` (fallback `slug`), secondary `slug` / id | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `packages/app/src/knowledge-bases/knowledge-base-hub-row.ts`, `packages/app/src/i18n/resources/en.ts`      | none     | K1-fix          |
| Hub list shows usage summary when known (`Mounted on N workspace(s)` / `Not mounted`)                | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`, `packages/protocol/src/knowledge-base/types.ts`, `packages/server/src/server/knowledge-base/service.ts`    | none     | K1-fix          |
| Hub row overflow exposes `Export` and `Delete`                                                       | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`                                                                                                             | none     | defer           |
| Delete-blocked flow lists workspace usages and refuses deletion while mounted                        | pass   | `packages/app/src/screens/knowledge-bases-screen.tsx`                                                                                                             | none     | defer           |

## Notes on the misses

### Host scope is only partially preserved — fixed (K1-fix)

`HostKnowledgeBasesPage` now pushes `buildKnowledgeBasesRoute(serverId)` (`/knowledge-bases?serverId=…`). The hub reads that query param and selects the matching host when present; otherwise it keeps the previous fallback to `hosts[0]`.

### Empty create landing — fixed outside this audit (K2b)

Empty create navigates to detail after submit. Not part of K1-fix.

### Hub rows under-communicate the KB record — fixed (K1-fix)

Rows now use primary `name` (fallback `slug`), secondary `slug · id`, and render mount usage from `mountedWorkspaceCount`.
