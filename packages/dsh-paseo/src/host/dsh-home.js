// Minimal $DSH_HOME helpers for the Cordis host entry.
// Kept dependency-free so Desktop can load this package from
// extraResources (no node_modules next to the linked sources).

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DSH_HOME_DIR_NAME = ".dsh";
const DSH_HOME_ENV = "DSH_HOME";

function defaultDshHome() {
  return join(homedir(), DSH_HOME_DIR_NAME);
}

function expandHomePath(pathValue) {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

/** Same precedence as @deepseek-ai/dsh-home-paths: $DSH_HOME, else ~/.dsh. */
export function resolveDshHome(env = process.env) {
  const fromEnv = env[DSH_HOME_ENV];
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome();
  return resolve(expandHomePath(raw));
}

export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}
