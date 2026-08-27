// Paseo-aligned MCP tools (Phase 1). Single-agent semantics: a DSH session is
// the analogue of a Paseo agent. All tools talk to the DSH Web host API via
// the shared transport (src/api/transport.js). See HANDOFF.md and the
// implementation plan (Phase 1) for scope; worktree_* and schedule/permission
// tools are intentionally absent (they need the Phase 3 host plugin / RPCs the
// host API does not expose).

import { z } from "zod";
import { resolveBaseUrl, rpc, unwrap, textResult, errorResult } from "../api/transport.js";
import { toAgentView, toWorkspaceView, resolveSessionId } from "../api/session-view.js";
import { setPermissionPreset } from "../api/permission.js";

async function withBase(baseUrl, fn) {
  const base = await resolveBaseUrl(baseUrl);
  return fn(base);
}

const baseUrlField = {
  baseUrl: z.string().optional().describe("Override DSH Web base URL, e.g. http://127.0.0.1:3080"),
};

export function registerPaseoTools(server) {
  server.registerTool(
    "list_agents",
    {
      title: "List agents (sessions)",
      description:
        "List DSH sessions as paseo-style agent rows: id, title, status (running/pending/idle), model, provider, cwd, turns. Blank sessions and subagent-origin rows are excluded unless includeAll.",
      inputSchema: {
        includeAll: z
          .boolean()
          .optional()
          .describe("Include blank sessions and subagent-origin rows (default: false)"),
        cwd: z.string().optional().describe("Filter by exact working directory"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ includeAll = false, cwd, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const list = unwrap(await rpc(base, "session.list", {}), "session.list");
          let rows = (list.items ?? [])
            .map(toAgentView)
            .filter((row) => includeAll || (!row.blank && row.origin !== "subagent"));
          if (cwd) rows = rows.filter((row) => row.cwd === cwd);
          return textResult({ baseUrl: base, count: rows.length, agents: rows });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create agent (session)",
      description:
        "Create a new DSH session. Prefer workspaceId so it attaches to a sidebar group; pass only cwd to accept Ungrouped. Pass initialPrompt to make it visible in the GUI immediately.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Existing workspace id (preferred)"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory; mutually exclusive with workspaceId"),
        sessionId: z.string().optional().describe("Optional preallocated session id"),
        agentPreset: z
          .string()
          .optional()
          .describe("Optional agent preset id (standard/minimal/code/...)"),
        permission: z
          .string()
          .optional()
          .describe(
            "Permission preset: read-only | workspace-write | danger-full-access (aliases: write, full, yolo)",
          ),
        initialPrompt: z.string().optional().describe("First user message; flips blank→visible"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async (args) => {
      try {
        if (args.workspaceId && args.cwd) {
          throw new Error("create_agent accepts workspaceId or cwd, not both");
        }
        return await withBase(args.baseUrl, async (base) => {
          const payload = {};
          if (args.workspaceId) payload.workspaceId = args.workspaceId;
          if (args.cwd) payload.cwd = args.cwd;
          if (args.sessionId) payload.sessionId = args.sessionId;
          if (args.agentPreset) payload.agentPreset = args.agentPreset;
          const created = unwrap(await rpc(base, "session.create", payload), "session.create");

          let permission = null;
          if (args.permission) {
            permission = await setPermissionPreset(base, created.sessionId, args.permission);
          }

          let prompt = null;
          if (args.initialPrompt && args.initialPrompt.trim()) {
            prompt = unwrap(
              await rpc(base, "session.prompt", {
                sessionId: created.sessionId,
                mode: "queue",
                content: [{ type: "text", text: args.initialPrompt }],
              }),
              "session.prompt",
            );
          }
          return textResult({
            baseUrl: base,
            ...created,
            permission,
            blank: !(args.initialPrompt && args.initialPrompt.trim()),
            prompt,
            note: args.initialPrompt?.trim()
              ? "First prompt accepted; session should appear in the GUI."
              : "Session is blank and may be hidden in the GUI until the first prompt.",
          });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "set_agent_permission",
    {
      title: "Set agent permission preset",
      description:
        "Switch a session permission preset via /permission (read-only | workspace-write | danger-full-access).",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        permission: z
          .string()
          .describe("Permission preset (read-only | workspace-write | danger-full-access)"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, permission, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          const value = await setPermissionPreset(base, target.sessionId, permission);
          return textResult({ baseUrl: base, sessionId: target.sessionId, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send prompt to agent (session)",
      description: "Queue a user text prompt on an existing session.",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        text: z.string().describe("User message text"),
        mode: z.enum(["queue", "steer"]).optional().describe("Default: queue"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, text, mode, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          const value = unwrap(
            await rpc(base, "session.prompt", {
              sessionId: target.sessionId,
              mode: mode ?? "queue",
              content: [{ type: "text", text }],
            }),
            "session.prompt",
          );
          return textResult({ baseUrl: base, sessionId: target.sessionId, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the live status row for one session (session.list item projected to a paseo agent row).",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          return textResult({ baseUrl: base, agent: toAgentView(target) });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity (logs)",
      description: "Return the most recent session events (session.history) for one session.",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        limit: z.number().int().positive().max(500).optional().describe("Max events (default: 50)"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, limit = 50, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          const value = unwrap(
            await rpc(base, "session.history", { sessionId: target.sessionId, limit }),
            "session.history",
          );
          const events = (value.events ?? []).map((entry) => {
            const e = entry.event ?? {};
            return { type: e.type, seq: e.seq, time: e.time, data: e.data };
          });
          return textResult({
            baseUrl: base,
            sessionId: target.sessionId,
            count: events.length,
            events,
          });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel agent (interrupt)",
      description: "Interrupt a running session (session.cancel).",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          const value = unwrap(
            await rpc(base, "session.cancel", { sessionId: target.sessionId }),
            "session.cancel",
          );
          return textResult({ baseUrl: base, sessionId: target.sessionId, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List registered DSH workspaces with session counts.",
      inputSchema: {
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(await rpc(base, "workspace.list", {}), "workspace.list");
          return textResult({
            baseUrl: base,
            count: (value.items ?? []).length,
            workspaces: (value.items ?? []).map(toWorkspaceView),
            archivedSessionIds: value.archivedSessionIds ?? [],
          });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Register an existing local directory as a DSH workspace. The path must already exist; this does not mkdir. Re-registering the same path returns created:false.",
      inputSchema: {
        path: z.string().describe("Absolute path to an existing directory"),
        title: z.string().optional().describe("Display title (defaults to directory basename)"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ path, title, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const payload = { path };
          if (title) payload.title = title;
          const value = unwrap(await rpc(base, "workspace.create", payload), "workspace.create");
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description: "Set a workspace display title.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id"),
        title: z.string().min(1).describe("New display title"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ workspaceId, title, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(
            await rpc(base, "workspace.rename", { workspaceId, title }),
            "workspace.rename",
          );
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description:
        "Remove a workspace registration (workspace.delete). The directory and every session log are kept; the sessions become Ungrouped.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace id"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ workspaceId, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(
            await rpc(base, "workspace.delete", { workspaceId }),
            "workspace.delete",
          );
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description: "List LLM models available on the host (llm.models).",
      inputSchema: {
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(await rpc(base, "llm.models", {}), "llm.models");
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List LLM providers configured on the host (llm.providers).",
      inputSchema: {
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(await rpc(base, "llm.providers", {}), "llm.providers");
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- Phase 3 tools (need the paseo-host plugin mounted in the profile) ---

  server.registerTool(
    "worktree_create",
    {
      title: "Create worktree",
      description:
        "Create a paseo-style git worktree under $DSH_HOME/worktrees/<hash>/<slug>/ and register it as a DSH workspace. Requires the paseo-host plugin mounted on the Web host (paseo.worktree.create).",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Main repository directory (default: the host process cwd)"),
        mode: z.enum(["branch-off", "checkout-branch"]).optional().describe("Default: branch-off"),
        branchName: z.string().optional().describe("New branch for branch-off mode"),
        baseRef: z.string().optional().describe("Base ref for branch-off mode (default: HEAD)"),
        branch: z.string().optional().describe("Existing branch for checkout-branch mode"),
        slug: z.string().optional().describe("Worktree directory slug"),
        title: z.string().optional().describe("Workspace display title"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async (args) => {
      try {
        return await withBase(args.baseUrl, async (base) => {
          const value = unwrap(
            await rpc(base, "paseo.worktree.create", args),
            "paseo.worktree.create",
          );
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "worktree_list",
    {
      title: "List worktrees",
      description:
        "List paseo-style worktrees under $DSH_HOME/worktrees (requires the paseo-host plugin).",
      inputSchema: {
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(await rpc(base, "paseo.worktree.list", {}), "paseo.worktree.list");
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "worktree_archive",
    {
      title: "Archive worktree",
      description:
        "Archive a worktree: removes the worktree directory and its branch, and drops its workspace registration (requires the paseo-host plugin).",
      inputSchema: {
        name: z.string().describe("Worktree slug, branch name, or path"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ name, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const value = unwrap(
            await rpc(base, "paseo.worktree.archive", { name }),
            "paseo.worktree.archive",
          );
          return textResult({ baseUrl: base, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "archive_agent",
    {
      title: "Archive agent (session)",
      description:
        "Archive a session (soft delete, paseo archive semantics). The session disappears from active lists but its log is kept (requires the paseo-host plugin).",
      inputSchema: {
        sessionId: z.string().describe("Target session id or its short prefix"),
        baseUrl: baseUrlField.baseUrl,
      },
    },
    async ({ sessionId, baseUrl }) => {
      try {
        return await withBase(baseUrl, async (base) => {
          const target = await resolveSessionId(base, sessionId);
          const value = unwrap(
            await rpc(base, "paseo.session.archive", { sessionId: target.sessionId }),
            "paseo.session.archive",
          );
          return textResult({ baseUrl: base, sessionId: target.sessionId, ...value });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
