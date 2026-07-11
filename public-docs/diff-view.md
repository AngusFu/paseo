---
title: Diff view
description: Switch diff engines, compare branches, and read word-level highlights in the Changes pane.
nav: Diff view
order: 12
category: Workspaces
---

# Diff view

The Changes pane renders every file diff for a workspace. This page covers the diff engine picker, comparing against an arbitrary branch, and the smaller reading aids (word-level highlighting, split layout).

## Diff engines

The **Engine** menu in the Changes pane header picks how file contents are diffed:

- **Git**, the default. Choose an **Algorithm** from the same menu: **Histogram**, **Myers**, or **Patience**, matching `git diff --diff-algorithm`.
- **VS Code**, an in-process engine, always available, no external binary required.
- **Difftastic**, a structural, AST-aware diff. It highlights what actually changed inside a line or expression instead of just changed lines.

Not every server offers all three, the menu only lists VS Code and Difftastic when the server advertises support for them.

### Installing Difftastic

Difftastic isn't bundled. If a server can run it but doesn't have it yet, the engine menu shows **Install difftastic…**. Selecting it downloads the pinned Difftastic release for your platform, verifies it, and installs it to `$PASEO_HOME/bin`; the item reads **Installing difftastic…** while that's in progress.

If you already have `difft` installed yourself, from Homebrew, Cargo, or anywhere else on `PATH`, Paseo uses that instead of installing its own copy. To point at a specific binary, set:

```bash
PASEO_DIFFT_PATH=/path/to/difft
```

When Difftastic can't run on a file, that file falls back to Git's line diff and shows a **line diff** badge next to its name, the rest of the diff still uses Difftastic.

## Comparing branches

The diff mode menu (top of the Changes pane) has three options: **Uncommitted**, **Committed**, and **Compare with branch…**. Picking a branch opens a compare bar with:

- **Compare against…**, pick the other ref (defaults to the current branch's `HEAD`).
- **Swap**, flip the two sides.
- **Only changes on this branch** / **Full diff**, toggle whether the comparison is against the merge base (just this branch's changes) or a straight two-point diff.

## Reading the diff

Changed words within a line are highlighted, not just the whole line, so a one-word edit in a long line is easy to spot.

### Text size

The diff options menu (the **⋯** overflow in the Changes pane header) has a **Text size** section with seven steps, from **Extra small** to **Gigantic**. **Medium** is the default, matching your editor code font size, and the other steps scale up or down from it. The choice persists across reloads.

The split (side-by-side) layout needs room for two code columns. Below roughly 720px of pane width it's dropped in favor of unified, and the split/unified toggle hides until the pane is wide enough.
