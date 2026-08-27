// worktree-core — pure git-worktree logic for the dsh-paseo host plugin.
// Mirrors paseo's layout (packages/server/src/utils/worktree.ts):
//   <worktreesRoot>/<8-char deterministic hash>/<slug>/
// hash = base36(sha256(git-common-dir))[:8]  (stable per repository)
// slug = slugified branch name, or a short random id.
// This module has no cordis deps so it can be unit-tested standalone.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readdir, mkdir, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const execFileP = promisify(execFile);

export const WORKTREE_HASH_LENGTH = 8;

/** Run git in `cwd` and return trimmed stdout. */
export async function git(args, cwd) {
  const { stdout } = await execFileP("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/** sha256 of `value` → base36 → 8 chars (paseo deriveShortAlphanumericHash). */
export function deriveShortAlphanumericHash(value) {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let i = 0; i < 8; i += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[i] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_HASH_LENGTH);
}

/** The 8-char hash for a repository: hashes its git common dir (resolved). */
export async function deriveWorktreeProjectHash(repoCwd) {
  const commonDir = await git(["rev-parse", "--git-common-dir"], repoCwd);
  const abs = isAbsolute(commonDir) ? commonDir : join(repoCwd, commonDir);
  return deriveShortAlphanumericHash(abs);
}

/** Lowercase alphanumeric+dash slug (paseo validateBranchSlug-ish). */
export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Create a worktree under `<root>/<hash>/<slug>/`.
 * @param {object} opts
 * @param {string} opts.repoCwd - main repository working directory.
 * @param {'branch-off'|'checkout-branch'} [opts.mode] - default 'branch-off'.
 * @param {string} [opts.branchName] - new branch for branch-off; existing branch for checkout-branch.
 * @param {string} [opts.baseRef] - base ref for branch-off (default: HEAD).
 * @param {string} [opts.slug] - directory slug (default: slugify(branchName) or a mnemonic name).
 * @param {string} opts.root - worktrees root directory.
 * @returns {Promise<{worktreePath: string, branchName: string, slug: string, hash: string}>}
 */
export async function createWorktree({
  repoCwd,
  mode = "branch-off",
  branchName,
  baseRef,
  slug,
  root,
}) {
  const hash = await deriveWorktreeProjectHash(repoCwd);
  let normalizedSlug;
  if (slug) normalizedSlug = slugify(slug);
  else if (branchName) normalizedSlug = slugify(branchName);
  else normalizedSlug = slugify(`wt-${randomBytes(4).toString("hex")}`);
  if (!normalizedSlug) throw new Error("worktree slug is empty after normalization");
  const dir = join(root, hash, normalizedSlug);
  await mkdir(join(root, hash), { recursive: true });

  if (mode === "checkout-branch") {
    if (!branchName) throw new Error("checkout-branch mode requires --branch <existing-branch>");
    await git(["worktree", "add", dir, branchName], repoCwd);
  } else {
    // branch-off: create branchName from baseRef (default HEAD)
    const branch = branchName ?? normalizedSlug;
    const base = baseRef ?? "HEAD";
    await git(["worktree", "add", "-b", branch, dir, base], repoCwd);
  }
  return {
    worktreePath: dir,
    branchName: branchName ?? normalizedSlug,
    slug: normalizedSlug,
    hash,
  };
}

/**
 * List existing worktrees under `root` (directories only; ignores the sidecar file).
 * @param {string} root
 * @returns {Promise<Array<{hash: string, slug: string, path: string}>>}
 */
export async function listWorktrees(root) {
  const out = [];
  let hashDirs = [];
  try {
    hashDirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // root does not exist yet
  }
  for (const hash of hashDirs) {
    const hashDir = join(root, hash);
    let slugs = [];
    try {
      slugs = (await readdir(hashDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const slug of slugs) out.push({ hash, slug, path: join(hashDir, slug) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Remove a worktree and (optionally) its branch.
 * @param {object} opts
 * @param {string} opts.worktreePath - worktree directory to remove.
 * @param {string} [opts.branchName] - branch to delete after removal.
 * @param {boolean} [opts.removeBranch] - default true.
 * @param {string} [opts.mainRepoRoot] - main repo to run branch deletion in.
 * @returns {Promise<void>}
 */
export async function archiveWorktree({
  worktreePath,
  branchName,
  removeBranch = true,
  mainRepoRoot,
}) {
  await git(["worktree", "remove", "--force", worktreePath], mainRepoRoot ?? worktreePath);
  if (removeBranch && branchName) {
    try {
      await git(["branch", "-D", branchName], mainRepoRoot);
    } catch {
      // branch already gone or is the current branch elsewhere — best effort
    }
  }
  // prune now-empty hash dirs
  const parent = join(worktreePath, "..");
  try {
    const rest = await readdir(parent);
    if (rest.length === 0) await rm(parent, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
