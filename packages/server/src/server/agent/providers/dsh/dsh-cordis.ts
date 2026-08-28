import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";

import type { McpServerConfig } from "../../agent-sdk-types.js";
import { toDshMcpCordisEntries } from "./dsh-mcp.js";
import { readLlmPiAiProviders, type DshProfileState } from "./dsh-profile.js";

export interface DshCordisMaterializeInput {
  baseCordisPath: string;
  profile: DshProfileState;
  sessionMcpServers?: Record<string, McpServerConfig>;
}

export interface DshCordisMaterializeResult {
  path: string;
  cleanup: () => void;
}

interface CordisEntry {
  id?: string;
  name?: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
  insert?: CordisEntry[];
}

export function materializeDshCordis(input: DshCordisMaterializeInput): DshCordisMaterializeResult {
  const overlayEntries = buildCordisOverlayEntries(input.profile, input.sessionMcpServers);

  const dir = mkdtempSync(join(tmpdir(), "paseo-dsh-cordis-"));
  const path = join(dir, "cordis.yml");

  // Bundled/runtime Cordis uses DSH-specific YAML tags such as `!!js` for env
  // expressions. js-yaml cannot round-trip those tags, so copy the base file
  // verbatim and append only Paseo-owned overlay entries.
  const baseText = readFileSync(input.baseCordisPath, "utf8").trimEnd();
  const overlayText =
    overlayEntries.length > 0 ? `\n${dump(overlayEntries, { noRefs: true }).trimEnd()}` : "";
  writeFileSync(path, `${baseText}${overlayText}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function buildCordisOverlayEntries(
  profile: DshProfileState,
  sessionMcpServers?: Record<string, McpServerConfig>,
): CordisEntry[] {
  const entries: CordisEntry[] = [];
  const existingIds = new Set<string>();

  const llmProviders = readLlmPiAiProviders(profile.settings);
  if (Object.keys(llmProviders).length > 0) {
    // The Python SDK runtime ships as a Node SEA binary. External Cordis plugins
    // resolve from NODE_PATH (llm-pi-ai works); bundled-only plugins such as
    // dsh-credentials-local and dsh-settings-file break boot. Auth for pi-ai
    // routes comes from applyDshRuntimeEnv() injecting ~/.dsh/.credentials.yaml.
    upsertEntry(entries, existingIds, {
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: { providers: llmProviders },
    });
  }

  const mcpEntries = toDshMcpCordisEntries(sessionMcpServers);
  for (const entry of mcpEntries) {
    upsertEntry(entries, existingIds, entry);
  }

  applyCordisPatch(entries, existingIds, profile.cordisPatch);
  return entries;
}

/** Merge overlay entries into an already-parsed base Cordis array (tests/helpers). */
export function mergeCordisEntries(
  baseEntries: CordisEntry[],
  profile: DshProfileState,
  sessionMcpServers?: Record<string, McpServerConfig>,
): CordisEntry[] {
  const entries = [...baseEntries];
  const existingIds = new Set(
    entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
  );

  for (const overlay of buildCordisOverlayEntries(profile, sessionMcpServers)) {
    upsertEntry(entries, existingIds, overlay);
  }

  return entries;
}

function upsertEntry(entries: CordisEntry[], existingIds: Set<string>, entry: CordisEntry): void {
  if (!entry.id) {
    entries.push(entry);
    return;
  }
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    entries[index] = { ...entries[index], ...entry };
    return;
  }
  entries.push(entry);
  existingIds.add(entry.id);
}

function applyCordisPatch(entries: CordisEntry[], existingIds: Set<string>, patch: unknown): void {
  if (!Array.isArray(patch)) {
    return;
  }
  for (const item of patch) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const patchEntry = item as CordisEntry;
    if (Array.isArray(patchEntry.insert)) {
      for (const inserted of patchEntry.insert) {
        upsertEntry(entries, existingIds, inserted);
      }
      continue;
    }
    if (typeof patchEntry.id !== "string") {
      continue;
    }
    upsertEntry(entries, existingIds, patchEntry);
  }
}

export function copyBundledCordis(baseCordisPath: string, targetPath: string): void {
  copyFileSync(baseCordisPath, targetPath);
}
