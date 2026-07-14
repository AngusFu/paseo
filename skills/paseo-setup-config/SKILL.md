---
name: paseo-setup-config
description: Generate or update a project's Paseo config (paseo.json / paseo.local.json). Use whenever the user wants to set up, configure, scaffold, or edit Paseo for a repo — "configure paseo", "set up paseo.json", "add a paseo script/service", "paseo worktree setup command", "make a paseo.local.json", "why isn't my paseo config working" — even if they don't name the file — including deciding which of paseo.json or paseo.local.json to write.
user-invocable: true
argument-hint: "[what to configure, e.g. 'dev server on 3000' or 'personal DB url']"
---

# Paseo: set up config

Author or update the Paseo config for the current project. Two files exist and you must pick the right one; that choice is the whole job.

**User's request:** $ARGUMENTS

## The two files

- **`paseo.json`** — shared, committed to git. Team-wide project setup everyone gets.
- **`paseo.local.json`** — personal, git-ignored. Deep-overrides `paseo.json` at runtime. Same shape; a key set here wins over the same key in `paseo.json`.

Merge is a deep merge: plain objects merge recursively (a local file can change one script's `port` without restating the command); arrays and scalars from the local file replace the base wholesale.

## Config schema

All fields optional. Unknown keys are preserved — never drop keys you didn't touch.

```jsonc
{
  "worktree": {
    // Commands run when a worktree is created. String or array of strings.
    "setup": ["npm install"],
    // Commands run when a worktree is torn down.
    "teardown": ["npm run clean"],
  },
  "scripts": {
    // Named commands. Key = script name.
    "dev": {
      "command": "npm run dev", // string or array of strings
      "type": "service", // "service" = supervised long-running process
      "port": 3000, // number or string; exposed as $PASEO_PORT
    },
  },
  "metadataGeneration": {
    // Override the AI prompt instructions for generated artifacts.
    "branchName": { "instructions": "..." },
    "commitMessage": { "instructions": "..." },
    "pullRequest": { "instructions": "..." },
  },
}
```

- `worktree.setup` / `teardown`: bootstrap/cleanup commands. Keep them idempotent.
- `scripts`: `type: "service"` for anything long-running (dev server, watcher). Prefer letting Paseo assign the port and passing it through — `"command": "PORT=$PASEO_PORT npm run dev"` — instead of hardcoding `port`; a fixed port collides across parallel worktrees.
- `metadataGeneration.<key>.instructions`: replaces the default prompt for that artifact wholesale (not appended). Only add when the project has real naming/format conventions.

## Which file to write

Decide before writing. Ask only if genuinely ambiguous.

1. **User said "local" / "personal" / "just for me" / mentions a secret, a machine-specific path, or a port they alone use** → `paseo.local.json`.
2. **Setting up the project for the whole team (setup commands, the canonical dev script)** → `paseo.json`.
3. **`paseo.json` already exists and the user wants a _tweak_ or _override_** (different port, extra local-only script, swap one command) → `paseo.local.json`, containing only the overridden keys — rely on the deep merge, don't copy the rest.
4. **`paseo.json` exists and the change is genuinely shared** (fixing the team dev command, adding a service everyone needs) → edit `paseo.json` in place.
5. **No config at all yet** → start with `paseo.json` for the shared baseline; peel personal bits into `paseo.local.json` only if the user flags them.

**Before writing `paseo.local.json`, warn the user it won't show up in Paseo's project-settings panel** — that built-in editor only reads and writes `paseo.json`. A local file takes effect at runtime but stays invisible in the UI.

When unsure between "shared" and "personal", state your pick and why in one line, then proceed — the user corrects if wrong.

## Workflow

1. **Read what's there.** Load existing `paseo.json` and `paseo.local.json` if present. Never blind-overwrite; merge your change into the existing content and keep unknown keys.
2. **Inspect the project** to derive real values — don't guess:
   - package manager + scripts: `package.json`, lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb`), or the equivalent for non-JS stacks (`Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, `docker-compose.yml`).
   - the dev/build/test commands and any service ports actually used.
   - **agent knowledge bases** (`.claude/knowledge/`, `.claude/CONVENTIONS.md`, or similar): teams that run agents often record dev-server flags, worktree pitfalls, and process-cleanup incidents there — each note usually maps 1:1 to a config line (e.g. a Nuxt fork-mode incident → `npm run dev -- --no-fork` in the service command).
   - **git hooks** (`.husky/*` + the scripts they call, commitlint config, MR/PR templates in `.gitlab/merge_request_templates/` or `.github/`): read the actual validation scripts, not just their names — they define the branch/commit/PR contracts that belong in `metadataGeneration` instructions verbatim (regex, allowed prefixes, worked example, squash-vs-merge policy).
3. **Draft** the minimal config that serves the request. Minimal beats exhaustive — only fields that matter.
4. **Pick the file and confirm** per the rules above — show the user the config and target file so they can adjust.
5. **Write** valid JSON, 2-space indent, trailing newline. If you wrote `paseo.local.json`, confirm it's git-ignored — prefer the project's `.gitignore` if the team already ignores it; otherwise use `.git/info/exclude` (local-only, doesn't touch team files uninvited).

## Field lessons for worktree setup/teardown

- **A fresh worktree has no gitignored files.** Symlink every gitignored `.env*` from the source checkout before installing — profile files (`.env.staging.local`) matter too, and copying just `.env` silently breaks them:
  `for f in $(git -C "$PASEO_SOURCE_CHECKOUT_PATH" ls-files --others --ignored --exclude-standard -- '.env*'); do ln -sf "$PASEO_SOURCE_CHECKOUT_PATH/$f" "./$f"; done`
- **`npm install --prefer-offline`** — worktrees reinstall the same tree repeatedly; exploit the cache.
- **Symlink gitignored agent-config dirs too.** If `.claude/`, `.cursor/`, `.agents/` (etc.) are gitignored in the main repo, agents launched in the worktree can't see their knowledge bases, skills, or rules. Check `git check-ignore <dir>` and link the ignored ones:
  `for d in .claude .cursor; do if [ -e "$PASEO_SOURCE_CHECKOUT_PATH/$d" ] && [ ! -e "./$d" ]; then ln -s "$PASEO_SOURCE_CHECKOUT_PATH/$d" "./$d"; fi; done`
- **Symlink agent-instruction docs too.** Committed docs (`CLAUDE.md`, `AGENTS.md`) ride along with the checkout, but their gitignored/local variants (`CLAUDE.local.md`, `AGENTS.local.md`, `AGENTS.dev.md`, …) don't exist in a fresh worktree, so an agent launched there loses that guidance. The `[ ! -e ./$f ]` guard links only what's missing, so listing committed names too is harmless:
  `for f in AGENTS.md AGENTS.local.md CLAUDE.md CLAUDE.local.md; do if [ -e "$PASEO_SOURCE_CHECKOUT_PATH/$f" ] && [ ! -e "./$f" ]; then ln -s "$PASEO_SOURCE_CHECKOUT_PATH/$f" "./$f"; fi; done`
- **Lockfile-name churn**: if `package.json` has no `name` field, npm writes the worktree's directory basename into `package-lock.json`'s root `name` on install. Add `git checkout -- package-lock.json` after the install step.
- **Teardown is usually unnecessary.** On archive/delete Paseo already: kills all workspace terminals (services die there) → runs teardown → `git worktree remove --force` → `rm -rf` fallback → `prune`. Untracked files can't block deletion, so `git clean` in teardown is pointless. Teardown is for external resources (test DBs, tunnels) plus one cheap orphan-process insurance line: `pkill -f "$PWD" || true` (path-scoped, pkill never matches itself).
- **Branch names get slugified.** Paseo lowercases/kebab-cases worktree branch names (they feed service-proxy hostnames), so an uppercase/underscore branch contract (`fix/KEY_slug`) cannot be produced at creation; if the repo enforces one via pre-push hook, the agent must `git branch -m` after landing in the worktree.

## Pitfalls

- **Settings panel edits `paseo.json` only.** Values you put in `paseo.local.json` never appear in Paseo's project-settings UI — the edit RPC reads and writes the base file alone. Avoid surprise: when you write a local file, tell the user it lives only on disk, not in the panel.
- **Runtime uses the merged value, the panel shows the base.** Worktree setup/teardown, scripts/services, and metadata prompts read `paseo.json` deep-merged with `paseo.local.json`; the panel shows the base. If a key is overridden locally, say so — the effective value differs from what the UI displays.
- **A non-object `paseo.local.json` wipes the config.** Valid-but-non-object JSON at the top level (`[]`, `"x"`, `42`) wins the merge and replaces the whole config, which then falls back to empty — worktree setup and scripts silently vanish at runtime. Always write the local file as a top-level JSON object.
- **Not git-ignoring the local file leaks it.** If the project's `.gitignore` doesn't cover `paseo.local.json`, it gets committed and "personal" settings reach the whole team. Ensure it's ignored before you finish.
- **Local is read from the base checkout's working tree.** Paseo reads config from the base branch checkout you picked, on disk; `paseo.local.json` is git-ignored so it never travels through git to other worktrees or branches. Put it in the base checkout root, next to `paseo.json`.

## Rules

- Valid JSON only (no comments in the written file — the schema block above uses jsonc for docs).
- `paseo.local.json` holds only overrides, not a full copy — the deep merge fills the rest.
- Don't invent fields outside the schema; Paseo ignores unknown keys but they add noise.
