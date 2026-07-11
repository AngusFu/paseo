---
name: paseo-setup-config
description: Generate or update a project's Paseo config (paseo.json / paseo.local.json). Use whenever the user wants to set up, configure, scaffold, or edit Paseo for a repo — "configure paseo", "set up paseo.json", "add a paseo script/service", "paseo worktree setup command", "make a paseo.local.json", "why isn't my paseo config working" — even if they don't name the file. Inspects the project, writes valid config, and picks the right file to touch.
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
- `scripts`: `type: "service"` for anything long-running (dev server, watcher). Give services a `port` when they bind one — Paseo hands it to the process as `$PASEO_PORT`.
- `metadataGeneration.<key>.instructions`: replaces the default prompt for that artifact wholesale (not appended). Only add when the project has real naming/format conventions.

## Which file to write

Decide before writing. Ask only if genuinely ambiguous.

1. **User said "local" / "personal" / "just for me" / mentions a secret, a machine-specific path, or a port they alone use** → `paseo.local.json`.
2. **Setting up the project for the whole team (setup commands, the canonical dev script)** → `paseo.json`.
3. **`paseo.json` already exists and the user wants a _tweak_ or _override_** (different port, extra local-only script, swap one command) → `paseo.local.json`, containing only the overridden keys — rely on the deep merge, don't copy the rest.
4. **`paseo.json` exists and the change is genuinely shared** (fixing the team dev command, adding a service everyone needs) → edit `paseo.json` in place.
5. **No config at all yet** → start with `paseo.json` for the shared baseline; peel personal bits into `paseo.local.json` only if the user flags them.

When unsure between "shared" and "personal", state your pick and why in one line, then proceed — the user corrects if wrong.

## Workflow

1. **Read what's there.** Load existing `paseo.json` and `paseo.local.json` if present. Never blind-overwrite; merge your change into the existing content and keep unknown keys.
2. **Inspect the project** to derive real values — don't guess:
   - package manager + scripts: `package.json`, lockfile (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb`), or the equivalent for non-JS stacks (`Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, `docker-compose.yml`).
   - the dev/build/test commands and any service ports actually used.
3. **Draft** the minimal config that serves the request. Minimal beats exhaustive — only fields that matter.
4. **Pick the file** per the rules above.
5. **Show the user** the config and the target file; let them adjust.
6. **Write** valid JSON, 2-space indent, trailing newline. If you wrote `paseo.local.json`, confirm it's git-ignored (Paseo ships a `.gitignore` entry; add one if the project lacks it).

## Rules

- Valid JSON only (no comments in the written file — the schema block above uses jsonc for docs).
- Preserve every key you didn't intend to change.
- `paseo.local.json` holds only overrides, not a full copy — the deep merge fills the rest.
- Don't invent fields outside the schema; Paseo ignores unknown keys but they add noise.
