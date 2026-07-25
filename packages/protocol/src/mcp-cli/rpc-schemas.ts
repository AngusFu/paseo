import { z } from "zod";
import { McpCliRuntimeStatusSchema, McpCliServerConfigSchema } from "./types.js";

// FastMCP CLI management RPCs (docs/rpc-namespacing.md + docs/mcp-cli.md).

export const McpCliRuntimeStatusRequestSchema = z.object({
  type: z.literal("mcp_cli.runtime.status.request"),
  requestId: z.string(),
});

export const McpCliRuntimeInstallRequestSchema = z.object({
  type: z.literal("mcp_cli.runtime.install.request"),
  requestId: z.string(),
});

export const McpCliServersListRequestSchema = z.object({
  type: z.literal("mcp_cli.servers.list.request"),
  requestId: z.string(),
});

export const McpCliServersUpsertRequestSchema = z.object({
  type: z.literal("mcp_cli.servers.upsert.request"),
  requestId: z.string(),
  server: McpCliServerConfigSchema,
});

export const McpCliServersDeleteRequestSchema = z.object({
  type: z.literal("mcp_cli.servers.delete.request"),
  requestId: z.string(),
  name: z.string().min(1),
});

export const McpCliServersTestRequestSchema = z.object({
  type: z.literal("mcp_cli.servers.test.request"),
  requestId: z.string(),
  name: z.string().min(1),
});

export const McpCliRuntimeStatusResponseSchema = z.object({
  type: z.literal("mcp_cli.runtime.status.response"),
  payload: z.object({
    requestId: z.string(),
    status: McpCliRuntimeStatusSchema,
    error: z.string().nullable(),
  }),
});

export const McpCliRuntimeInstallResponseSchema = z.object({
  type: z.literal("mcp_cli.runtime.install.response"),
  payload: z.object({
    requestId: z.string(),
    status: McpCliRuntimeStatusSchema,
    error: z.string().nullable(),
  }),
});

export const McpCliServersListResponseSchema = z.object({
  type: z.literal("mcp_cli.servers.list.response"),
  payload: z.object({
    requestId: z.string(),
    servers: z.array(McpCliServerConfigSchema),
    error: z.string().nullable(),
  }),
});

export const McpCliServersUpsertResponseSchema = z.object({
  type: z.literal("mcp_cli.servers.upsert.response"),
  payload: z.object({
    requestId: z.string(),
    server: McpCliServerConfigSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const McpCliServersDeleteResponseSchema = z.object({
  type: z.literal("mcp_cli.servers.delete.response"),
  payload: z.object({
    requestId: z.string(),
    name: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const McpCliServersTestResponseSchema = z.object({
  type: z.literal("mcp_cli.servers.test.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    error: z.string().nullable(),
  }),
});
