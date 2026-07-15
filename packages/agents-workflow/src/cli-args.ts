/**
 * agents-workflow CLI — arg-building + journal-path pure logic.
 *
 * Pulled out of cli.ts so it's unit-testable without spawning the process
 * (cli.ts is process IO glue over this file — argv parse, process.exit,
 * stdout — and stays excluded from the coverage gate; this file is not).
 *
 * Parsing itself is yargs-parser (the standalone parser under yargs) so the
 * CLI follows community conventions for free: kebab<->camel expansion,
 * number coercion, `--no-x` negation, `--k=v` and `--k v` both work.
 */
import * as path from "node:path";
import yargsParser from "yargs-parser";

export interface ParsedArgs {
  _: string[];
  [k: string]: unknown;
}

/**
 * flags cmdRun/createBackend already own — must NOT leak into the `args`
 * global. Names are camelCase (yargs-parser's output space, see parseArgs).
 *
 * NOTE on negation: yargs-parser's `--no-x` does NOT produce a `noX` key —
 * it collapses onto the BASE key (`--no-journal` -> `{ journal: false }`,
 * `--no-strict` -> `{ strict: false }`). So `journal`/`strict` double as both
 * the "give me a value" flag and the negation target. The `noJournal`/`noStrict`
 * entries below are just a defensive net in case someone types the literal
 * camelCase form (`--noJournal`) — real `--no-x` usage never produces them.
 */
export const RESERVED_FLAGS = new Set([
  "backend",
  "mock",
  "provider",
  "waitTimeout",
  "cwd",
  "journal",
  "noJournal",
  "resume",
  "maxConcurrency",
  "maxAgents",
  "budget",
  "strict",
  "noStrict",
  "trace",
  "quiet",
  "args",
]);

/** yargs-parser opts: community defaults (camel expansion, --no-x negation,
 * number coercion) all ON, but identity keys forced to STRING so a numeric
 * ticket id/key/dir doesn't get coerced to a number, and `args` forced to
 * STRING too since its value is raw JSON text buildAgentArgs re-parses
 * itself (a bare numeric --args would otherwise arrive as a JS number and
 * fail the "must be a string" check below). */
const YARGS_OPTS: yargsParser.Options = {
  configuration: {
    "camel-case-expansion": true,
    "boolean-negation": true,
    "parse-numbers": true,
  },
  string: ["ticketId", "ticket-id", "key", "runtimeDir", "runtime-dir", "args"],
};

/**
 * Parse argv with yargs-parser, collapsed into camelCase-only space: drop
 * the kebab-duplicate keys camel-case-expansion also emits alongside the
 * camelCase one (keep `runtimeDir`, drop `runtime-dir`) so downstream code
 * only ever sees one spelling per flag. `_` = positionals (cast to string;
 * yargs-parser numeric-coerces bare-number positionals by default, but a
 * command/workflow-name positional is always a string here).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const raw = yargsParser(argv, YARGS_OPTS) as Record<string, unknown>;
  const out: ParsedArgs = { _: (raw._ as unknown[]).map(String) };
  for (const key of Object.keys(raw)) {
    if (key === "_" || key === "--" || key === "$0" || key.includes("-")) continue;
    out[key] = raw[key];
  }
  return out;
}

/** thrown by buildAgentArgs on a bad --args JSON or an unmergeable base + named combo. */
export class ArgsError extends Error {}

/** identity keys stay string even for the pathological `--ticketId true` -
 * the true/false->boolean poststep below only touches non-identity args. */
const IDENTITY_KEYS = new Set(["ticketId", "key", "runtimeDir"]);

/**
 * every parsed `--key` that is NOT reserved and NOT the `_` positional
 * bucket. yargs-parser coerces numbers but does NOT turn the string
 * "true"/"false" into a boolean for untyped keys — do that ourselves here
 * (community convention), skipping identity keys so they stay strings.
 */
export function collectNamedArgs(parsed: ParsedArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (key === "_" || RESERVED_FLAGS.has(key)) continue;
    let v = parsed[key];
    if (!IDENTITY_KEYS.has(key) && (v === "true" || v === "false")) v = v === "true";
    out[key] = v;
  }
  return out;
}

/**
 * Build the `args` global handed to the workflow script.
 *
 * base = `--args <json>` parsed first (if given); overlay = named `--<key>`
 * flags (named flags WIN on key collision). A bare-string/array `--args`
 * with NO named flags passes through untouched (deep-research takes a bare
 * string). A bare non-object `--args` PLUS named flags can't be merged ->
 * ArgsError. No `--args` and no named flags -> null (today's default).
 */
export function buildAgentArgs(parsed: ParsedArgs): unknown {
  const named = collectNamedArgs(parsed);
  const hasNamed = Object.keys(named).length > 0;

  let base: unknown;
  const hasBase = parsed.args !== undefined;
  if (hasBase) {
    if (typeof parsed.args !== "string") throw new ArgsError("--args must be valid JSON");
    try {
      base = JSON.parse(parsed.args);
    } catch {
      throw new ArgsError("--args must be valid JSON");
    }
  }

  if (!hasNamed) return hasBase ? base : null;
  if (!hasBase) return { ...named };

  if (base !== null && typeof base === "object" && !Array.isArray(base)) {
    return { ...(base as Record<string, unknown>), ...named };
  }
  throw new ArgsError("--args is not a JSON object; cannot merge with --<key> flags");
}

export interface JournalPlan {
  path: string | null;
  /** rm any existing file at `path` before Journal() opens it, so this run
   * starts from a clean mirror. false when resuming FROM this same path -
   * don't eat the cache you're about to replay. */
  wipeIfExists: boolean;
}

/** default path: co-locate with the gated artifact sandbox when the built
 * `args` gives us one (runtimeDir/key), else a per-workflow .aw file. */
export function deriveDefaultJournalPath(
  agentArgs: unknown,
  cwd: string,
  workflowName: string,
): string {
  if (agentArgs !== null && typeof agentArgs === "object" && !Array.isArray(agentArgs)) {
    const obj = agentArgs as Record<string, unknown>;
    if (typeof obj.runtimeDir === "string" && typeof obj.key === "string") {
      return path.join(obj.runtimeDir, obj.key, "journal.jsonl");
    }
  }
  return path.join(cwd, ".aw", "journal", `${workflowName}.jsonl`);
}

/** journal is ON by default. --journal/--no-journal/--resume override it. */
export function resolveJournalPlan(opts: {
  journalFlag?: string | boolean;
  noJournal?: boolean;
  resumeFlag?: string | boolean;
  agentArgs: unknown;
  cwd: string;
  workflowName: string;
}): JournalPlan {
  if (opts.noJournal) return { path: null, wipeIfExists: false };

  if (typeof opts.journalFlag === "string") {
    // explicit --journal: today's unconditional fresh-mirror behavior.
    return { path: opts.journalFlag, wipeIfExists: true };
  }

  if (typeof opts.resumeFlag === "string") {
    // --resume alone (no --journal): journal continues at the resume path,
    // never wiped - that IS the cache we're about to replay.
    return { path: opts.resumeFlag, wipeIfExists: false };
  }

  // default ON: derive a stable path, fresh per run start (no --resume in play).
  return {
    path: deriveDefaultJournalPath(opts.agentArgs, opts.cwd, opts.workflowName),
    wipeIfExists: true,
  };
}

/** slug a ticketId into a filesystem/URL-safe key: lowercase, run of non
 * [a-z0-9] chars -> single '-', trim leading/trailing '-'. "SCIF-123" ->
 * "scif-123". */
export function slugifyTicketId(ticketId: string): string {
  return ticketId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** default `key` when --key not given: slug of ticketId, else a run-<ts> id.
 * `now` is injected (not Date.now() called in here) so this stays a pure,
 * unit-testable fn — the CLI (host side, allowed to touch Date.now()) passes
 * the real timestamp in at the call site. */
export function deriveDefaultKey(ticketId: unknown, now: number): string {
  if (typeof ticketId === "string" && ticketId.length > 0) return slugifyTicketId(ticketId);
  return `run-${now}`;
}

/** default `runtimeDir` when --runtimeDir not given: AW_RUNTIME_DIR env
 * override, else XDG_STATE_HOME/aw (XDG state-dir convention), else a
 * project-local ./.aw next to wherever the CLI was invoked from. */
export function deriveDefaultRuntimeDir(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  if (env.AW_RUNTIME_DIR) return env.AW_RUNTIME_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "aw");
  return path.join(cwd, ".aw");
}

export interface RuntimeDefaultsOpts {
  env: Record<string, string | undefined>;
  cwd: string;
  now: number;
}

/**
 * Inject runtimeDir/key defaults into an OBJECT agentArgs, only filling keys
 * not already set (explicit --runtimeDir/--key always win). Bare-string/
 * array agentArgs (deep-research's bare prompt, etc.) pass through
 * untouched — those flows don't take a {runtimeDir,key} bag, so there's
 * nothing to default.
 */
export function applyRuntimeDefaults(agentArgs: unknown, opts: RuntimeDefaultsOpts): unknown {
  if (agentArgs === null || typeof agentArgs !== "object" || Array.isArray(agentArgs))
    return agentArgs;
  const obj = agentArgs as Record<string, unknown>;
  const key =
    typeof obj.key === "string" && obj.key.length > 0
      ? obj.key
      : deriveDefaultKey(obj.ticketId, opts.now);
  const runtimeDir =
    typeof obj.runtimeDir === "string" && obj.runtimeDir.length > 0
      ? obj.runtimeDir
      : deriveDefaultRuntimeDir(opts.env, opts.cwd);
  return { ...obj, key, runtimeDir };
}
