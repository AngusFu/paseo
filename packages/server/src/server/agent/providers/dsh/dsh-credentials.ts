import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

import { resolveDshHome } from "./dsh-home.js";

export function resolveDshCredentialsPath(dshHome?: string): string {
  return join(resolveDshHome(dshHome ? { profileHome: dshHome } : undefined), ".credentials.yaml");
}

/** Load `$DSH_HOME/.credentials.yaml` refs into env-shaped key/value pairs. */
export function loadDshCredentialRefs(dshHome?: string): Record<string, string> {
  const credentialsPath = resolveDshCredentialsPath(dshHome);
  if (!existsSync(credentialsPath)) {
    return {};
  }

  try {
    const parsed = load(readFileSync(credentialsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const refs = (parsed as { refs?: unknown }).refs;
    if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
      return {};
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(refs)) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        env[key] = trimmed;
      }
    }
    return env;
  } catch {
    return {};
  }
}

export function applyDshRuntimeEnv(
  env: Record<string, string>,
  input?: { dshHome?: string },
): void {
  const dshHome = input?.dshHome?.trim() || resolveDshHome();
  env.DSH_HOME = dshHome;

  for (const [key, value] of Object.entries(loadDshCredentialRefs(dshHome))) {
    if (!env[key]) {
      env[key] = value;
    }
  }

  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const) {
    if (env[key]) {
      continue;
    }
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
}
