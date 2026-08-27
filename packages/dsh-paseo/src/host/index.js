// dsh-paseo host plugin (Phase 3) — registers paseo-style RPC routes on
// ctx.webServer that speak the SAME wire envelope as the built-in apiproxy
// (POST /api/<method>; {type:'client-request', rpcId, method, payload} →
// {type:'server-response', rpcId, result:{ok,value}}). CLI and MCP clients
// therefore reach them with the shared transport unchanged.
//
// Routes:
//   /api/paseo.worktree.create   {cwd?, mode?, branchName?, baseRef?, branch?, slug?, title?}
//   /api/paseo.worktree.list     {}
//   /api/paseo.worktree.archive  {name}   (slug | branch | path)
//   /api/paseo.session.archive   {sessionId}
//
// Layout mirrors paseo: <worktreesRoot>/<8-char deterministic hash>/<slug>/,
// where worktreesRoot = $DSH_HOME/worktrees (dshHomePath('worktrees')).
// Git metadata (mainRepoRoot, branch) that DSH's workspace record does not
// carry lives in a sidecar at <root>/.worktrees.json.

import { readFile, writeFile, mkdir, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { dshHomePath } from "./dsh-home.js";
import { createWorktree, listWorktrees, archiveWorktree } from "./worktree-core.js";

export const name = "paseo-host";
export const inject = ["webServer", "workspaceRegistry"];

const WORKTREES_ROOT = () => dshHomePath("worktrees");
const META_FILE = () => join(WORKTREES_ROOT(), ".worktrees.json");

// ---- envelope helpers ------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res, rpcId, value) {
  sendJson(res, 200, { type: "server-response", rpcId, result: { ok: true, value } });
}

function fail(res, rpcId, code, message) {
  sendJson(res, 200, {
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code, message } },
  });
}

/** Wrap a handler: parse envelope, dispatch, translate throws to {ok:false}. */
function route(handle) {
  return async (req, res) => {
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method not allowed" });
    }
    let rpcId = null;
    try {
      const body = await readJsonBody(req);
      rpcId = body.rpcId ?? null;
      if (body.type !== "client-request") {
        return fail(res, rpcId, "bad-request", "expected type: client-request");
      }
      const value = await handle(body.payload ?? {});
      return ok(res, rpcId, value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(res, rpcId, "rpc-error", message);
    }
  };
}

// ---- sidecar ---------------------------------------------------------------

async function readMeta() {
  try {
    return JSON.parse(await readFile(META_FILE(), "utf8"));
  } catch {
    return [];
  }
}

async function writeMeta(rows) {
  await mkdir(WORKTREES_ROOT(), { recursive: true });
  const tmp = `${META_FILE()}.tmp`;
  await writeFile(tmp, JSON.stringify(rows, null, 2));
  await rename(tmp, META_FILE());
}

// ---- route handlers --------------------------------------------------------

async function handleWorktreeCreate(payload) {
  const { cwd, mode, branchName, baseRef, branch, slug, title } = payload;
  const repoCwd = cwd ?? process.cwd();
  const result = await createWorktree({
    repoCwd,
    mode: mode ?? "branch-off",
    branchName: branchName ?? branch,
    baseRef,
    slug,
    root: WORKTREES_ROOT(),
  });

  const meta = await readMeta();
  meta.push({
    hash: result.hash,
    slug: result.slug,
    path: result.worktreePath,
    branchName: result.branchName,
    mainRepoRoot: repoCwd,
    createdAt: new Date().toISOString(),
  });
  await writeMeta(meta);

  // Register as a DSH workspace so sessions attach to a sidebar group.
  let workspace = null;
  try {
    workspace = await ctxWorkspace.create(result.worktreePath, title ?? result.slug);
  } catch {
    // registration is best-effort; the worktree itself is already created
  }

  return {
    worktreePath: result.worktreePath,
    hash: result.hash,
    slug: result.slug,
    branchName: result.branchName,
    workspace,
  };
}

async function handleWorktreeList() {
  const rows = await listWorktrees(WORKTREES_ROOT());
  const meta = await readMeta();
  const byPath = new Map(meta.map((m) => [m.path, m]));
  const workspaces = ctxWorkspace.list();
  const workspacesByCanon = new Map();
  for (const w of workspaces) workspacesByCanon.set(w.path, w);
  // The registry stores realpath-canonical paths (/tmp → /private/tmp on macOS),
  // so canonicalize worktree paths before matching.
  const canonOf = new Map();
  for (const r of rows) {
    try {
      canonOf.set(r.path, await realpath(r.path));
    } catch {
      canonOf.set(r.path, r.path);
    }
  }
  return {
    count: rows.length,
    worktrees: rows.map((r) => {
      const canon = canonOf.get(r.path);
      return Object.assign({}, r, {
        branchName: byPath.get(r.path)?.branchName ?? null,
        mainRepoRoot: byPath.get(r.path)?.mainRepoRoot ?? null,
        workspaceId: workspacesByCanon.get(canon)?.id ?? null,
      });
    }),
  };
}

async function handleWorktreeArchive(payload) {
  const { name: worktreeName } = payload;
  if (!worktreeName) throw new Error("worktree archive requires name (slug, branch, or path)");
  const rows = await listWorktrees(WORKTREES_ROOT());
  const meta = await readMeta();
  const match =
    rows.find((r) => r.slug === worktreeName || r.path === worktreeName) ??
    rows.find((r) => meta.find((m) => m.path === r.path)?.branchName === worktreeName);
  if (!match) throw new Error(`worktree not found: ${worktreeName}`);

  const record = meta.find((m) => m.path === match.path);

  // Resolve the workspace registration BEFORE removing the directory
  // (registry.resolveByPath realpaths the path, which fails once it is gone).
  const workspace = ctxWorkspace.resolveByPath
    ? await ctxWorkspace.resolveByPath(match.path).catch(() => null)
    : null;

  await archiveWorktree({
    worktreePath: match.path,
    branchName: record?.branchName,
    mainRepoRoot: record?.mainRepoRoot,
  });
  await writeMeta(meta.filter((m) => m.path !== match.path));

  // Drop the workspace registration (logs/sessions are kept).
  if (workspace) {
    try {
      await ctxWorkspace.delete(workspace.id);
    } catch {
      /* best effort */
    }
  }
  return { removed: match.path, branchName: record?.branchName ?? null };
}

async function handleSessionArchive(payload) {
  const { sessionId } = payload;
  if (!sessionId) throw new Error("session archive requires sessionId");
  await ctxWorkspace.archiveSession(sessionId);
  return { sessionId, archived: true };
}

// ctx.workspaceRegistry — bound in apply().
let ctxWorkspace = null;

export function apply(ctx) {
  ctxWorkspace = ctx.workspaceRegistry;

  const routes = [
    ["/api/paseo.worktree.create", handleWorktreeCreate],
    ["/api/paseo.worktree.list", handleWorktreeList],
    ["/api/paseo.worktree.archive", handleWorktreeArchive],
    ["/api/paseo.session.archive", handleSessionArchive],
  ];
  const disposers = routes.map(([path, handle]) =>
    ctx.webServer.register({ kind: "exact", path, handler: route(handle) }),
  );
  return () => disposers.forEach((dispose) => dispose());
}
