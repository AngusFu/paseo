#!/usr/bin/env node
// Smoke test for the dsh-paseo host plugin (src/host/index.js) with a mocked
// cordis ctx: registers routes, then exercises them with the real envelope
// (client-request → server-response) against a temp git repo and a temp
// DSH_HOME. Run with: DSH_HOME=/tmp/... node src/host/smoke-plugin.mjs

import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { apply } from "./index.js";

const repo = mkdtempSync(join(tmpdir(), "dsh-paseo-repo-"));
const dshHome = mkdtempSync(join(tmpdir(), "dsh-paseo-home-"));
process.env.DSH_HOME = dshHome;

// --- fixture repo -----------------------------------------------------------
execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
execFileSync("sh", ["-c", "echo hi > f.txt && git add f.txt && git commit -qm init"], {
  cwd: repo,
});

// --- fake ctx ---------------------------------------------------------------
const archiveCalls = [];
const registered = [];
const fakeCtx = {
  webServer: {
    register(route) {
      registered.push(route);
      return () => {};
    },
  },
  workspaceRegistry: {
    create: async (path, title) => ({ id: "wks_test", path, title }),
    list: () => [],
    resolveByPath: async () => null,
    delete: async () => true,
    archiveSession: async (sessionId) => archiveCalls.push(sessionId),
  },
};

const disposer = apply(fakeCtx);
const byPath = new Map(registered.map((r) => [r.path, r.handler]));

// --- envelope helpers -------------------------------------------------------
function invoke(handler, payload) {
  const body = JSON.stringify({ type: "client-request", rpcId: "r1", method: "x", payload });
  const req = Readable.from([Buffer.from(body)]);
  req.method = "POST";
  let out = "";
  const res = {
    writeHead() {},
    end(s) {
      out += s;
    },
  };
  return handler(req, res).then(() => JSON.parse(out));
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures += 1;
}

// --- run --------------------------------------------------------------------
try {
  const created = await invoke(byPath.get("/api/paseo.worktree.create"), {
    cwd: repo,
    branchName: "feat/beta",
  });
  check(
    "worktree.create ok",
    created.result?.ok === true,
    JSON.stringify(created.result?.value?.worktreePath),
  );
  const wtPath = created.result?.value?.worktreePath;
  check(
    "worktree.create path under DSH_HOME/worktrees",
    wtPath?.startsWith(join(dshHome, "worktrees")),
    wtPath,
  );
  check(
    "worktree.create slug",
    created.result?.value?.slug === "feat-beta",
    created.result?.value?.slug,
  );

  const listed = await invoke(byPath.get("/api/paseo.worktree.list"), {});
  check("worktree.list ok", listed.result?.ok === true && listed.result?.value?.count === 1);
  check(
    "worktree.list has branch",
    listed.result?.value?.worktrees?.[0]?.branchName === "feat/beta",
  );

  const archived = await invoke(byPath.get("/api/paseo.session.archive"), {
    sessionId: "session-x",
  });
  check("session.archive ok", archived.result?.ok === true);
  check(
    "session.archive called registry",
    archiveCalls.length === 1 && archiveCalls[0] === "session-x",
  );

  const removed = await invoke(byPath.get("/api/paseo.worktree.archive"), { name: "feat-beta" });
  check("worktree.archive ok", removed.result?.ok === true, removed.result?.error?.message ?? "");
  check("worktree.archive removed path", removed.result?.value?.removed === wtPath);

  const empty = await invoke(byPath.get("/api/paseo.worktree.list"), {});
  check("worktree.list empty after archive", empty.result?.value?.count === 0);

  const bad = await invoke(byPath.get("/api/paseo.worktree.archive"), { name: "nope" });
  check("worktree.archive unknown -> ok:false", bad.result?.ok === false);
} finally {
  disposer();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dshHome, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
