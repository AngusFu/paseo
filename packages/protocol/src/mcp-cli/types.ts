import { z } from "zod";

/** OAuth fields the user pastes from Claude/Cursor MCP config. */
export const McpCliOAuthAuthSchema = z.object({
  kind: z.literal("oauth"),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().optional(),
  scope: z.string().optional(),
});

export const McpCliServerAuthSchema = z.discriminatedUnion("kind", [McpCliOAuthAuthSchema]);

export const McpCliServerConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  enabled: z.boolean(),
  auth: McpCliServerAuthSchema.optional(),
  /** True when this row comes from a built-in preset (atlassian/figma). */
  preset: z.boolean().optional(),
});

export type McpCliServerConfig = z.infer<typeof McpCliServerConfigSchema>;
export type McpCliOAuthAuth = z.infer<typeof McpCliOAuthAuthSchema>;

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
