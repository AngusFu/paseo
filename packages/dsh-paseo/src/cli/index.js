#!/usr/bin/env node
// dsh-paseo CLI — paseo-aligned commands over the DSH Web host API.
// Phase 2: ls / run / send / logs / wait / stop / workspace / models / daemon status.
// Single-agent semantics: a DSH session is the analogue of a Paseo agent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveBaseUrl, rpc, unwrap } from "../api/transport.js";
import { toAgentView, toWorkspaceView, resolveSessionId } from "../api/session-view.js";
import { renderTable, renderJson, renderYaml, renderQuiet } from "./output.js";

const VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;

function die(message, hint = true) {
  console.error(`dsh-paseo: ${message}`);
  if (hint) {
    console.error(
      "Cannot reach DSH Web. Start DeepSeek Harness in Paseo Desktop, or pass --host http://127.0.0.1:<port> (after the subcommand).",
    );
  }
  process.exit(1);
}

/** Resolve the host base URL (flag → env → default → loopback probe) or exit. */
async function getBase(host) {
  try {
    return await resolveBaseUrl(host);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

const SLEEP_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilIdle(base, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = await resolveSessionId(base, sessionId);
    if (!target.running) return target;
    if (Date.now() > deadline) {
      die(`session ${sessionId} still running after ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(SLEEP_MS);
  }
}

function addGlobalOptions(cmd) {
  return cmd
    .option("-o, --format <format>", 'output format: table, json, yaml (default: "table")')
    .option("--json", "output in JSON format (alias for --format json)")
    .option("-q, --quiet", "minimal output (IDs only)")
    .option(
      "--host <baseUrl>",
      "DSH Web base URL, e.g. http://127.0.0.1:64167 (place after the subcommand)",
    );
}

function formatOf(opts) {
  if (opts.quiet) return "quiet";
  if (opts.json) return "json";
  return opts.format ?? "table";
}

function printRows(rows, columns, idField, opts) {
  const format = formatOf(opts);
  switch (format) {
    case "json":
      console.log(renderJson(rows));
      break;
    case "yaml":
      console.log(renderYaml(rows));
      break;
    case "quiet":
      console.log(renderQuiet(rows, idField));
      break;
    default:
      console.log(renderTable(rows, columns));
  }
}

function printValue(value, opts) {
  const format = formatOf(opts);
  switch (format) {
    case "json":
      console.log(renderJson(value));
      break;
    case "yaml":
      console.log(renderYaml(value));
      break;
    default:
      console.log(renderYaml(value));
  }
}

function shortId(id) {
  return String(id ?? "")
    .replace(/^session-/, "")
    .slice(0, 8);
}

const AGENT_COLUMNS = [
  { header: "SESSION ID", field: "id", width: 24 },
  { header: "NAME", field: "title", width: 32 },
  { header: "STATUS", field: "status", width: 9 },
  { header: "MODEL", field: "model", width: 32 },
  { header: "PROVIDER", field: "provider", width: 24 },
  { header: "CWD", field: "cwd", width: 48 },
  { header: "TURNS", field: "turns", width: 6 },
];

const program = new Command();

program
  .name("dsh-paseo")
  .description("Control DSH (DeepSeek Harness) sessions from the command line, paseo-style")
  .version(VERSION, "-V, --version", "output the version number");

// ---- ls -------------------------------------------------------------------
addGlobalOptions(
  program
    .command("ls")
    .description("List agents (sessions). Excludes blank and subagent rows unless --all.")
    .option("-a, --all", "include blank sessions and subagent-origin rows")
    .option("--cwd <path>", "filter by exact working directory"),
).action(async (opts) => {
  const base = await getBase(opts.host);
  const list = unwrap(await rpc(base, "session.list", {}), "session.list");
  let rows = (list.items ?? [])
    .map((it) => Object.assign(toAgentView(it), { id: it.sessionId }))
    .filter((row) => opts.all || (!row.blank && row.origin !== "subagent"));
  if (opts.cwd) rows = rows.filter((row) => row.cwd === opts.cwd);
  rows.forEach((row) => {
    row.id = shortId(row.sessionId);
  });
  printRows(rows, AGENT_COLUMNS, "id", opts);
});

// ---- run ------------------------------------------------------------------
addGlobalOptions(
  program
    .command("run")
    .description("Create a session with a task prompt (waits for idle unless --background)")
    .argument("<prompt>", "the task/prompt for the agent")
    .option("--title <title>", "assign a title to the session (best-effort rename)")
    .option("--workspace <id>", "attach to an existing workspace id")
    .option(
      "--cwd <path>",
      "working directory (default: current directory; ignored with --workspace)",
    )
    .option("--agent-preset <id>", "agent preset id (standard/code/minimal/cordis)")
    .option(
      "--permission <preset>",
      "permission preset: read-only | workspace-write | danger-full-access",
    )
    .option("-d, --background", "do not wait for the session to finish"),
).action(async (prompt, opts) => {
  const base = await getBase(opts.host);
  const payload = {};
  if (opts.workspace) payload.workspaceId = opts.workspace;
  else payload.cwd = opts.cwd ?? process.cwd();
  if (opts.agentPreset) payload.agentPreset = opts.agentPreset;
  const created = unwrap(await rpc(base, "session.create", payload), "session.create");
  const sessionId = created.sessionId;

  if (opts.permission) {
    const { setPermissionPreset } = await import("../api/permission.js");
    await setPermissionPreset(base, sessionId, opts.permission);
  }

  if (opts.title) {
    try {
      await rpc(base, "session.rename", { sessionId, title: opts.title });
    } catch (err) {
      console.error(
        `dsh-paseo: warning: could not set title: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const prompted = unwrap(
    await rpc(base, "session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    }),
    "session.prompt",
  );

  let status = "queued";
  if (!opts.background) {
    const target = await waitUntilIdle(base, sessionId, 180_000);
    status = target.running ? "running" : "idle";
  }
  printValue({ sessionId, baseUrl: base, accepted: prompted.accepted, status }, opts);
});

// ---- send -----------------------------------------------------------------
addGlobalOptions(
  program
    .command("send")
    .description("Send a message/task to an existing session")
    .argument("<session-id>", "session id or short prefix")
    .argument("<prompt>", "message text"),
).action(async (sessionId, prompt, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  const value = unwrap(
    await rpc(base, "session.prompt", {
      sessionId: target.sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    }),
    "session.prompt",
  );
  printValue({ sessionId: target.sessionId, ...value }, opts);
});

addGlobalOptions(
  program
    .command("permission")
    .description(
      "Set a session permission preset (read-only | workspace-write | danger-full-access)",
    )
    .argument("<session-id>", "session id or short prefix")
    .argument("<preset>", "permission preset name"),
).action(async (sessionId, preset, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  const { setPermissionPreset } = await import("../api/permission.js");
  const value = await setPermissionPreset(base, target.sessionId, preset);
  printValue({ sessionId: target.sessionId, ...value }, opts);
});

// ---- logs -----------------------------------------------------------------
addGlobalOptions(
  program
    .command("logs")
    .description("View session activity (recent session events)")
    .argument("<session-id>", "session id or short prefix")
    .option("-n, --limit <n>", "max events (default: 50)", "50"),
).action(async (sessionId, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  const value = unwrap(
    await rpc(base, "session.history", {
      sessionId: target.sessionId,
      limit: Number(opts.limit),
    }),
    "session.history",
  );
  const events = (value.events ?? []).map((entry) => {
    const e = entry.event ?? {};
    const text = pickText(e.data);
    return {
      seq: e.seq,
      type: e.type,
      time: typeof e.time === "number" ? new Date(e.time).toISOString() : e.time,
      text,
    };
  });
  printRows(
    events,
    [
      { header: "SEQ", field: "seq", width: 10 },
      { header: "TYPE", field: "type", width: 28 },
      { header: "TIME", field: "time", width: 20 },
      { header: "TEXT", field: "text", width: 120 },
    ],
    "seq",
    opts,
  );
});

function pickText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.text === "string") return data.text;
  if (Array.isArray(data.content)) {
    return data.content
      .map((c) => (c?.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ---- wait -----------------------------------------------------------------
addGlobalOptions(
  program
    .command("wait")
    .description("Wait for a session to become idle")
    .argument("<session-id>", "session id or short prefix")
    .option("--timeout <seconds>", "max wait in seconds (default: 60)", "60"),
).action(async (sessionId, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  if (!target.running) {
    printValue({ sessionId: target.sessionId, status: "idle" }, opts);
    return;
  }
  const idle = await waitUntilIdle(base, target.sessionId, Number(opts.timeout) * 1000);
  printValue({ sessionId: target.sessionId, status: idle.running ? "running" : "idle" }, opts);
});

// ---- stop -----------------------------------------------------------------
addGlobalOptions(
  program
    .command("stop")
    .description("Interrupt a session if it is running (no-op for idle sessions)")
    .argument("<session-id>", "session id or short prefix"),
).action(async (sessionId, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  const value = unwrap(
    await rpc(base, "session.cancel", { sessionId: target.sessionId }),
    "session.cancel",
  );
  printValue({ sessionId: target.sessionId, ...value }, opts);
});

// ---- workspace ------------------------------------------------------------
const workspace = program.command("workspace").description("Manage DSH workspaces");

addGlobalOptions(
  workspace
    .command("create")
    .description("Register an existing directory as a workspace (does not mkdir)")
    .argument("<path>", "absolute path to an existing directory")
    .option("--title <title>", "display title (defaults to directory basename)"),
).action(async (path, opts) => {
  const base = await getBase(opts.host);
  const payload = { path };
  if (opts.title) payload.title = opts.title;
  const value = unwrap(await rpc(base, "workspace.create", payload), "workspace.create");
  printValue({ baseUrl: base, ...value }, opts);
});

addGlobalOptions(workspace.command("ls").description("List workspaces")).action(async (opts) => {
  const base = await getBase(opts.host);
  const value = unwrap(await rpc(base, "workspace.list", {}), "workspace.list");
  const rows = (value.items ?? []).map((w) => toWorkspaceView(w));
  printRows(
    rows,
    [
      { header: "WORKSPACE ID", field: "workspaceId", width: 24 },
      { header: "TITLE", field: "title", width: 32 },
      { header: "PATH", field: "path", width: 60 },
      { header: "SESSIONS", field: "sessionCount", width: 9 },
    ],
    "workspaceId",
    opts,
  );
});

addGlobalOptions(
  workspace
    .command("rename")
    .description("Set a workspace display title")
    .argument("<workspace-id>", "workspace id")
    .argument("<title>", "new display title"),
).action(async (workspaceId, title, opts) => {
  const base = await getBase(opts.host);
  const value = unwrap(
    await rpc(base, "workspace.rename", { workspaceId, title }),
    "workspace.rename",
  );
  printValue({ workspaceId, ...value }, opts);
});

// ---- archive ---------------------------------------------------------------
addGlobalOptions(
  program
    .command("archive")
    .description("Archive a session (soft delete; needs the paseo-host plugin mounted)")
    .argument("<session-id>", "session id or short prefix"),
).action(async (sessionId, opts) => {
  const base = await getBase(opts.host);
  const target = await resolveSessionId(base, sessionId);
  const value = unwrap(
    await rpc(base, "paseo.session.archive", { sessionId: target.sessionId }),
    "paseo.session.archive",
  );
  printValue({ sessionId: target.sessionId, ...value }, opts);
});

// ---- worktree --------------------------------------------------------------
const worktree = program
  .command("worktree")
  .description("Manage Paseo-style git worktrees (needs the paseo-host plugin mounted)");

addGlobalOptions(
  worktree
    .command("create")
    .description(
      "Create a worktree under $DSH_HOME/worktrees/<hash>/<slug>/ and register it as a workspace",
    )
    .option("--mode <mode>", "creation mode: branch-off (default) or checkout-branch")
    .option("--new-branch <name>", "new branch name for branch-off mode")
    .option("--base <ref>", "base ref for branch-off mode (default: HEAD)")
    .option("--branch <name>", "existing branch for checkout-branch mode")
    .option("--slug <slug>", "worktree directory slug (default: from branch name)")
    .option("--title <title>", "workspace display title (default: the slug)")
    .option("--cwd <path>", "main repository directory (default: current)"),
).action(async (opts) => {
  const base = await getBase(opts.host);
  const payload = { cwd: opts.cwd, mode: opts.mode };
  if (opts.newBranch) payload.branchName = opts.newBranch;
  if (opts.base) payload.baseRef = opts.base;
  if (opts.branch) payload.branch = opts.branch;
  if (opts.slug) payload.slug = opts.slug;
  if (opts.title) payload.title = opts.title;
  const value = unwrap(await rpc(base, "paseo.worktree.create", payload), "paseo.worktree.create");
  printValue(value, opts);
});

addGlobalOptions(worktree.command("ls").description("List Paseo-style worktrees")).action(
  async (opts) => {
    const base = await getBase(opts.host);
    const value = unwrap(await rpc(base, "paseo.worktree.list", {}), "paseo.worktree.list");
    const rows = value.worktrees ?? [];
    printRows(
      rows,
      [
        { header: "SLUG", field: "slug", width: 28 },
        { header: "BRANCH", field: "branchName", width: 28 },
        { header: "HASH", field: "hash", width: 10 },
        { header: "PATH", field: "path", width: 64 },
        { header: "WORKSPACE", field: "workspaceId", width: 26 },
      ],
      "slug",
      opts,
    );
  },
);

addGlobalOptions(
  worktree
    .command("archive")
    .description("Archive a worktree (removes the worktree and its branch)")
    .argument("<name>", "worktree slug, branch name, or path"),
).action(async (name, opts) => {
  const base = await getBase(opts.host);
  const value = unwrap(
    await rpc(base, "paseo.worktree.archive", { name }),
    "paseo.worktree.archive",
  );
  printValue(value, opts);
});

// ---- models ---------------------------------------------------------------
addGlobalOptions(program.command("models").description("List LLM models on the host")).action(
  async (opts) => {
    const base = await getBase(opts.host);
    const value = unwrap(await rpc(base, "llm.models", {}), "llm.models");
    printValue({ baseUrl: base, ...value }, opts);
  },
);

// ---- daemon status --------------------------------------------------------
const daemon = program
  .command("daemon")
  .description("Manage the DSH Web daemon (status only in this phase)");
addGlobalOptions(daemon.command("status").description("Show the DSH Web host status")).action(
  async (opts) => {
    const base = await getBase(opts.host);
    const value = unwrap(await rpc(base, "host.describe", {}), "host.describe");
    const rows = [
      { key: "Base URL", value: base },
      { key: "Version", value: value.version },
      { key: "CWD", value: value.cwd },
      { key: "Default provider", value: value.provider },
      { key: "Default model", value: value.model },
      { key: "Attached sessions", value: value.attachedSessions },
      { key: "Home", value: value.home },
    ];
    printRows(
      rows,
      [
        { header: "KEY", field: "key", width: 24 },
        { header: "VALUE", field: "value", width: 72 },
      ],
      "key",
      opts,
    );
  },
);

program.parseAsync(process.argv).catch((err) => {
  die(err instanceof Error ? err.message : String(err), false);
});
