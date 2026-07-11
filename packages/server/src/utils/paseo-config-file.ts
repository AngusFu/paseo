import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PaseoConfigRawSchema,
  type PaseoConfigRaw,
  type PaseoConfigRevision,
  type ProjectConfigRpcError,
} from "@getpaseo/protocol/paseo-config-schema";
export {
  PaseoConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type PaseoConfigRevision,
  type ProjectConfigRpcError,
} from "@getpaseo/protocol/paseo-config-schema";

export const PASEO_CONFIG_FILE_NAME = "paseo.json";
export const PASEO_LOCAL_CONFIG_FILE_NAME = "paseo.local.json";

export type ReadPaseoConfigForEditResult =
  | { ok: true; config: PaseoConfigRaw | null; revision: PaseoConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };

export type WritePaseoConfigForEditResult =
  | { ok: true; config: PaseoConfigRaw; revision: PaseoConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

export interface WritePaseoConfigForEditInput {
  repoRoot: string;
  config: PaseoConfigRaw;
  expectedRevision: PaseoConfigRevision | null;
}

export function resolvePaseoConfigPath(repoRoot: string): string {
  return join(repoRoot, PASEO_CONFIG_FILE_NAME);
}

export function resolvePaseoLocalConfigPath(repoRoot: string): string {
  return join(repoRoot, PASEO_LOCAL_CONFIG_FILE_NAME);
}

export function statPaseoConfigPath(repoRoot: string): PaseoConfigRevision | null {
  const configPath = resolvePaseoConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  const stats = statSync(configPath);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function readJsonFileOrNull(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readPaseoConfigJson(repoRoot: string): unknown {
  return readJsonFileOrNull(resolvePaseoConfigPath(repoRoot));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// paseo.local.json overrides paseo.json. Plain objects merge recursively so a
// local file can tweak a single nested key (e.g. one script's port) without
// restating the rest; arrays and scalars are replaced wholesale by the local
// value.
export function deepMergeConfigJson(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    result[key] = key in base ? deepMergeConfigJson(base[key], overrideValue) : overrideValue;
  }
  return result;
}

// Runtime config read: paseo.json deep-merged with an optional paseo.local.json
// override. Returns null only when neither file exists, so callers keep their
// "no config" behavior. The edit RPC deliberately keeps reading paseo.json alone
// (readPaseoConfigJson) so round-tripping an edit never collapses the local
// override into the base file.
export function readMergedPaseoConfigJson(repoRoot: string): unknown {
  const base = readJsonFileOrNull(resolvePaseoConfigPath(repoRoot));
  const local = readJsonFileOrNull(resolvePaseoLocalConfigPath(repoRoot));
  if (base === null) {
    return local;
  }
  if (local === null) {
    return base;
  }
  return deepMergeConfigJson(base, local);
}

export function readPaseoConfigForEdit(repoRoot: string): ReadPaseoConfigForEditResult {
  try {
    const json = readPaseoConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null, revision: null };
    }
    return {
      ok: true,
      config: PaseoConfigRawSchema.parse(json),
      revision: statPaseoConfigPath(repoRoot),
    };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_project_config" },
    };
  }
}

export function writePaseoConfigForEdit(
  input: WritePaseoConfigForEditInput,
): WritePaseoConfigForEditResult {
  const parsed = PaseoConfigRawSchema.safeParse(input.config);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_project_config" } };
  }

  const configPath = resolvePaseoConfigPath(input.repoRoot);
  const tempPath = join(
    input.repoRoot,
    `.${PASEO_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
    const currentRevision = statPaseoConfigPath(input.repoRoot);
    if (!paseoConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
      removeTempPaseoConfig(tempPath);
      return {
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      };
    }

    renameSync(tempPath, configPath);
    const revision = statPaseoConfigPath(input.repoRoot);
    if (!revision) {
      return { ok: false, error: { code: "write_failed" } };
    }
    return { ok: true, config: parsed.data, revision };
  } catch {
    removeTempPaseoConfig(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

function paseoConfigRevisionsEqual(
  left: PaseoConfigRevision | null,
  right: PaseoConfigRevision | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function removeTempPaseoConfig(tempPath: string): void {
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup only; callers need the original write outcome.
  }
}
