import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_SESSION_PREFIX = "session-";
export const DSH_PASEO_DIR_NAME = "paseo";

export interface DshLocationOptions {
  profileHome?: string;
  sessionRoot?: string;
}

export interface DshLocation {
  profileHome: string;
  sessionRoot: string;
  pluginDir: string;
}

export function resolveDshHome(options?: DshLocationOptions): string {
  if (options?.profileHome?.trim()) {
    return expandHomePath(options.profileHome.trim());
  }
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) {
    return expandHomePath(fromEnv);
  }
  return join(homedir(), ".dsh");
}

export function resolveDshSessionRoot(options?: DshLocationOptions): string {
  if (options?.sessionRoot?.trim()) {
    return expandHomePath(options.sessionRoot.trim());
  }
  return join(resolveDshHome(options), "sessions");
}

export function resolveDshLocation(options?: DshLocationOptions): DshLocation {
  const profileHome = resolveDshHome(options);
  return {
    profileHome,
    sessionRoot: resolveDshSessionRoot(options),
    pluginDir: join(profileHome, DSH_PASEO_DIR_NAME),
  };
}

export function createDshSessionId(): string {
  return formatDshSessionId(randomUUID());
}

export function formatDshSessionId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return createDshSessionId();
  }
  if (trimmed.startsWith(DSH_SESSION_PREFIX)) {
    return trimmed;
  }
  return `${DSH_SESSION_PREFIX}${trimmed}`;
}

export function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
