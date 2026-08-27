/**
 * Permission preset helpers for DSH Web (`/permission` via commands/execute).
 *
 * Available presets (live-verified): read-only, workspace-write, danger-full-access.
 */

import { rpc, unwrap } from "./transport.js";

const ALIASES = {
  readonly: "read-only",
  "read-only": "read-only",
  read: "read-only",
  "workspace-write": "workspace-write",
  workspacewrite: "workspace-write",
  write: "workspace-write",
  "danger-full-access": "danger-full-access",
  dangerfullaccess: "danger-full-access",
  full: "danger-full-access",
  yolo: "danger-full-access",
};

export function normalizePermissionPreset(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
  return ALIASES[lowered] ?? trimmed;
}

/**
 * @param {string} base
 * @param {string} sessionId
 * @param {string} permission
 */
export async function setPermissionPreset(base, sessionId, permission) {
  const preset = normalizePermissionPreset(permission);
  if (!preset) {
    throw new Error("permission preset is required");
  }
  const executed = unwrap(
    await rpc(base, "commands/execute", {
      args: {
        agentId: sessionId,
        line: `/permission ${preset}`,
        images: [],
      },
    }),
    "commands/execute",
  );
  const result = executed?.result;
  if (result?.kind === "error") {
    throw new Error(result.text || `permission preset failed: ${preset}`);
  }
  return { preset, text: result?.text ?? `preset ${preset}` };
}
