import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Enumerate Chrome profiles from the macOS user data directory.
 * Returns only profiles that have a `Cookies` SQLite file on disk.
 */

export interface ChromeProfile {
  /** Profile directory name (`Default`, `Profile 1`, …). */
  id: string;
  /** Human-readable profile name from `Local State` (falls back to `id`). */
  name: string;
  /** Absolute path to the profile's `Cookies` SQLite file. */
  cookiesPath: string;
}

function chromeBaseDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

interface LocalState {
  profile?: {
    info_cache?: Record<string, { name?: string }>;
  };
}

/**
 * Lists Chrome profiles with a Cookies database. Returns `[]` when Chrome is not
 * installed or `Local State` is missing/unreadable.
 */
export function listChromeProfiles(): ChromeProfile[] {
  const baseDir = chromeBaseDir();
  const localStatePath = path.join(baseDir, "Local State");
  if (!existsSync(localStatePath)) {
    return [];
  }

  let infoCache: Record<string, { name?: string }> = {};
  try {
    const parsed = JSON.parse(readFileSync(localStatePath, "utf8")) as LocalState;
    infoCache = parsed.profile?.info_cache ?? {};
  } catch {
    return [];
  }

  const profiles: ChromeProfile[] = [];
  for (const [dir, info] of Object.entries(infoCache)) {
    const cookiesPath = path.join(baseDir, dir, "Cookies");
    if (!existsSync(cookiesPath)) {
      continue;
    }
    profiles.push({
      id: dir,
      name: info.name?.trim() || dir,
      cookiesPath,
    });
  }
  return profiles;
}
