#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveBaseUrl, rpc, unwrap, textResult, errorResult } from "../api/transport.js";
import { setPermissionPreset } from "../api/permission.js";
import { registerPaseoTools } from "./tools.js";

const server = new McpServer({
  name: "dsh-paseo",
  version: "0.2.0",
});

async function withBase(baseUrl, fn) {
  const base = await resolveBaseUrl(baseUrl);
  return fn(base);
}

server.registerTool(
  "workspace_list",
  {
    title: "List DSH workspaces",
    description: "List registered DSH workspaces and archived session ids on the local Web host.",
    inputSchema: {
      baseUrl: z
        .string()
        .optional()
        .describe("Override DSH Web base URL, e.g. http://127.0.0.1:52119"),
    },
  },
  async ({ baseUrl }) => {
    try {
      return await withBase(baseUrl, async (base) => {
        const value = unwrap(await rpc(base, "workspace.list", {}), "workspace.list");
        return textResult({ baseUrl: base, ...value });
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "workspace_create",
  {
    title: "Create DSH workspace",
    description:
      "Register an existing local directory as a DSH workspace. The path must already exist; this does not mkdir. Re-registering the same path returns created:false.",
    inputSchema: {
      path: z.string().describe("Absolute path to an existing directory"),
      baseUrl: z.string().optional().describe("Override DSH Web base URL"),
    },
  },
  async ({ path, baseUrl }) => {
    try {
      return await withBase(baseUrl, async (base) => {
        const value = unwrap(await rpc(base, "workspace.create", { path }), "workspace.create");
        return textResult({ baseUrl: base, ...value });
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "session_create",
  {
    title: "Create DSH session",
    description:
      "Create a new DSH conversation/session. Prefer workspaceId so it attaches to the sidebar group. Pass only cwd if you accept Ungrouped. Blank sessions are hidden in the GUI until the first prompt — set prompt to make it visible.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Existing workspace id (preferred)"),
      cwd: z.string().optional().describe("Working directory; mutually exclusive with workspaceId"),
      sessionId: z.string().optional().describe("Optional preallocated session id"),
      agentPreset: z.string().optional().describe("Optional agent preset id"),
      permission: z
        .string()
        .optional()
        .describe("Permission preset: read-only | workspace-write | danger-full-access"),
      prompt: z
        .string()
        .optional()
        .describe("Optional first user message; flips blank→visible in the GUI"),
      baseUrl: z.string().optional().describe("Override DSH Web base URL"),
    },
  },
  async (args) => {
    try {
      if (args.workspaceId && args.cwd) {
        throw new Error("session_create accepts workspaceId or cwd, not both");
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
        if (args.prompt && args.prompt.trim()) {
          prompt = unwrap(
            await rpc(base, "session.prompt", {
              sessionId: created.sessionId,
              mode: "queue",
              content: [{ type: "text", text: args.prompt }],
            }),
            "session.prompt",
          );
        }

        return textResult({
          baseUrl: base,
          ...created,
          permission,
          blank: !(args.prompt && args.prompt.trim()),
          prompt,
          note: args.prompt?.trim()
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
  "session_prompt",
  {
    title: "Send prompt to DSH session",
    description: "Queue a user text prompt on an existing session.",
    inputSchema: {
      sessionId: z.string().describe("Target session id"),
      text: z.string().describe("User message text"),
      mode: z.enum(["queue", "steer"]).optional().describe("Default: queue"),
      baseUrl: z.string().optional().describe("Override DSH Web base URL"),
    },
  },
  async ({ sessionId, text, mode, baseUrl }) => {
    try {
      return await withBase(baseUrl, async (base) => {
        const value = unwrap(
          await rpc(base, "session.prompt", {
            sessionId,
            mode: mode ?? "queue",
            content: [{ type: "text", text }],
          }),
          "session.prompt",
        );
        return textResult({ baseUrl: base, sessionId, ...value });
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

registerPaseoTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
