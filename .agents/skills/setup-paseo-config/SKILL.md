---
name: setup-paseo-config
description: Author or update a project's paseo.json / paseo.local.json (worktree setup/teardown, service scripts, metadata-generation instructions). Use when the user says "setup paseo config", "configure paseo.local.json", "给这个项目配置 paseo", or wants worktree lifecycle / dev-server / branch-name rules wired into Paseo for a target repo.
user-invocable: true
---

# Setup Paseo config for a project

Produce a `paseo.json` (team-shared, committed) or `paseo.local.json` (personal override) for a target repository. The schema of record is `packages/protocol/src/paseo-config-schema.ts`; the behavioral reference is `docs/development.md` § "paseo.json service scripts". Read both before writing anything.

## 1. Recon the target repo first — never write from assumptions

Mine these sources in the target project, in order of signal density:

1. **`.claude/knowledge/` (or similar agent KB)** — if the project has one, it is the gold mine: field lessons about worktrees, dev servers, env files, and process cleanup usually live here and are all directly actionable config.
2. **Git hooks** — `.husky/*`, `scripts/validate-*`: branch-name contracts, commitlint, pre-push checks. Read the actual validation script, not just its name; encode the real regex/allowlist into prose.
3. **`package.json`** — `dev`/`postinstall`/`prepare` scripts (what setup already happens automatically), package manager, lockfile presence.
4. **MR/PR templates** — `.gitlab/merge_request_templates/*.md`, `.github/PULL_REQUEST_TEMPLATE*`: section structure to reference in `metadataGeneration.pullRequest`.
5. **Framework quirks** — e.g. Nuxt 3.8+ `nuxi dev` defaults to fork mode (parent proxy + forked real server → orphan processes); the fix is `npm run dev -- --no-fork`. Check the KB for incident notes before trusting a bare `npm run dev`.

## 2. `worktree.setup` — what a fresh worktree is missing

A fresh worktree has NO gitignored files. Typical setup sequence:

```json
"setup": [
  "for f in $(git -C \"$PASEO_SOURCE_CHECKOUT_PATH\" ls-files --others --ignored --exclude-standard -- '.env*'); do ln -sf \"$PASEO_SOURCE_CHECKOUT_PATH/$f\" \"./$f\"; done",
  "npm install --prefer-offline",
  "git checkout -- package-lock.json"
]
```

- **Symlink every gitignored `.env*`** from `$PASEO_SOURCE_CHECKOUT_PATH` (Paseo injects it), not just `.env` — profile files like `.env.staging.local` matter, and copying just `.env` silently breaks them. Symlink beats copy: no token drift.
- **`--prefer-offline`** exploits the npm cache; worktrees install the same tree repeatedly.
- **Revert install side effects**: if `package.json` has no `name` field, npm writes the worktree's directory basename into `package-lock.json`'s root `name`, polluting every diff. `git checkout -- package-lock.json` after install.

## 3. `scripts` — services get ports from Paseo, never hardcode

`"type": "service"` entries are port-assigned by Paseo and proxied automatically. Do NOT set a fixed `port`. If the framework needs `PORT`, pass it in the command:

```json
"dev": { "type": "service", "command": "PORT=$PASEO_PORT npm run dev -- --no-fork" }
```

## 4. `worktree.teardown` — usually unnecessary; know what Paseo already does

On workspace archive/delete Paseo runs, in order: kill all workspace terminals (services die here) → teardown commands → `git worktree remove --force` → `rm -rf` retry fallback → `git worktree prune`. Untracked/generated files cannot block deletion, so `git clean` in teardown is pointless.

Teardown is for **external resources** (test databases, tunnels) plus one cheap insurance line against forked orphan processes:

```json
"teardown": ["pkill -f \"$PWD\" || true"]
```

Path-scoped, can't hit other checkouts, `pkill` never matches itself, `|| true` keeps deletion unblocked.

## 5. `metadataGeneration` — feed the repo's real contracts to the AI

Write `branchName` / `commitMessage` / `pullRequest` `instructions` as prose encoding what you found in step 1: the branch regex with a worked example, the commitlint types, the ticket-key convention (including the "no ticket" placeholder like `SCIF-0000` if the team uses one), the PR template's exact section headings, and the squash-vs-merge-commit policy (per branch type if the team distinguishes).

## 6. Local vs base, and delivery

- Machine paths, personal preferences → `paseo.local.json`; add it to the target repo's `.git/info/exclude` (never edit the team's `.gitignore` uninvited).
- Team-consensus config → `paseo.json`, committed via the team's normal review flow.
- Validate with a JSON parse before handing over, and show the user the final file.
