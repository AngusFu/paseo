import { z } from "zod";

/**
 * Pre-registered OAuth (Atlassian/Figma) or FastMCP DCR.
 * `clientId` present → runner uses FastMCP OAuth(client_id=…) + metadata patches.
 * `clientId` absent → stock FastMCP `auth="oauth"` (dynamic client registration).
 */
export const McpCliOAuthAuthSchema = z.object({
  kind: z.literal("oauth"),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().optional(),
  scope: z.string().optional(),
});

/** FastMCP RemoteMCPServer `auth` bearer token string. */
export const McpCliBearerAuthSchema = z.object({
  kind: z.literal("bearer"),
  token: z.string().min(1),
});

export const McpCliServerAuthSchema = z.discriminatedUnion("kind", [
  McpCliOAuthAuthSchema,
  McpCliBearerAuthSchema,
]);

export const McpCliTransportSchema = z.enum(["http", "stdio"]);

/**
 * Wire schema for a FastMCP CLI server row.
 * Shape mirrors FastMCP `MCPConfig` / Claude `mcpServers` where possible:
 * stdio → command/args/env/cwd; remote → url/headers/auth.
 * `transport` / `url` / `command` are validated further in an explicit
 * post-parse normalize step (http requires url; stdio requires command).
 * Absent `transport` means http for back-compat with stored presets.
 */
export const McpCliServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: McpCliTransportSchema.optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  /** FastMCP RemoteMCPServer.headers (e.g. Authorization). */
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  auth: McpCliServerAuthSchema.optional(),
  /** True when this row comes from a built-in preset (atlassian/figma). */
  preset: z.boolean().optional(),
});

export type McpCliServerConfig = z.infer<typeof McpCliServerConfigSchema>;
export type McpCliOAuthAuth = z.infer<typeof McpCliOAuthAuthSchema>;
export type McpCliBearerAuth = z.infer<typeof McpCliBearerAuthSchema>;
export type McpCliTransport = z.infer<typeof McpCliTransportSchema>;

export const McpCliRuntimeComponentStateSchema = z.enum([
  "missing",
  "present",
  "error",
  "unsupported",
]);

export type McpCliRuntimeComponentState = z.infer<typeof McpCliRuntimeComponentStateSchema>;

export const McpCliRuntimeStatusSchema = z.object({
  platformSupported: z.boolean(),
  platform: z.string(),
  uv: z.object({
    state: McpCliRuntimeComponentStateSchema,
    path: z.string().nullable(),
    message: z.string().nullable().optional(),
  }),
  venv: z.object({
    state: McpCliRuntimeComponentStateSchema,
    path: z.string().nullable(),
    message: z.string().nullable().optional(),
  }),
  runner: z.object({
    state: McpCliRuntimeComponentStateSchema,
    path: z.string().nullable(),
    message: z.string().nullable().optional(),
  }),
  ready: z.boolean(),
  /** Human-readable summary for the UI badge. */
  message: z.string().nullable().optional(),
});

export type McpCliRuntimeStatus = z.infer<typeof McpCliRuntimeStatusSchema>;
