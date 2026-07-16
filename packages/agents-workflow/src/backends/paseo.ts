/**
 * PaseoBackend — a real AgentBackend that runs each agent via the `paseo run`
 * CLI against a local paseo daemon.
 *
 * caveman law: this backend only RUNS a prompt and hands back the final text.
 * structured output is the ENGINE's job (the persona injects the JSON schema
 * and the engine does validate/retry), so this backend NEVER touches
 * `--output-schema` — that is the OLD runner.ts path (src/paseo.ts
 * buildPaseoArgs) and reusing it here would double up on schema.
 *
 * REAL --json shape surprise (verified live 2026-07-13, paseo 0.1.103):
 *   `paseo run --json ... -- <prompt>` prints ONLY a completion envelope:
 *     { "agentId": "...", "status": "completed", "provider": "claude",
 *       "cwd": "...", "title": "..." }
 *   it carries NEITHER the reply text NOR token usage. the reply text lives
 *   only in the daemon timeline (`paseo logs --filter text <id>`) and usage
 *   lives in `paseo inspect --json <id>` (LastUsage.OutputTokens). so run()
 *   parses the envelope for status/agentId, then FALLS BACK to a `logs` fetch
 *   to recover the final assistant text. the parser ALSO probes a set of
 *   text/usage fields DEFENSIVELY, so a future paseo build (or a test mock)
 *   that DOES embed text/usage in the envelope is served in one exec.
 *
 * contract: run() must RESOLVE (never reject) with { error } on ANY failure so
 * the engine can map it to agent()===null uniformly.
 */
import { execa } from "execa";
import { AgentBackend, type AgentSpec, type AgentResult, type AgentUsage } from "../backend.js";

/**
 * injected exec seam — mirrors src/paseo.ts realExec. tests swap a mock so
 * unit tests never spawn a real daemon. one call = one shell-out to paseo,
 * returns stdout.
 */
export type PaseoExec = (args: string[]) => Promise<string>;

export interface PaseoBackendOptions {
  /** exec seam. default = real execa("paseo", args) wrapper. */
  exec?: PaseoExec;
  /** provider used when a spec carries none (default "claude"). */
  defaultProvider?: string;
  /** model used when a spec carries none. omitted from args when unset. */
  defaultModel?: string;
  /** --thinking value used when a spec carries none. */
  defaultEffort?: string;
  /** --mode value used when a spec carries none. */
  defaultMode?: string;
  /**
   * Default feature values. Only `fast_mode` is currently forwarded to the CLI
   * (`--feature fast_mode=true`) once `paseo run` supports `--feature`.
   */
  defaultFeatureValues?: Record<string, unknown>;
  /** --wait-timeout value (e.g. "5m"). omitted from args when unset. */
  waitTimeout?: string;
  /** --cwd value. omitted from args when unset. */
  cwd?: string;
  /**
   * Pin every `paseo run` to this existing workspace (`--workspace`). Without
   * it, each bare `paseo run` mints a new directory workspace for the same cwd
   * — disastrous for workflows (1 agent() + structured retries = N workspaces).
   * Ignored when `spec.isolation === "worktree"` (CLI forbids combining the two).
   */
  workspaceId?: string;
  /**
   * Fix I — after a successful run, fetch REAL token usage via one extra
   * `paseo inspect --json <id>` exec (a metadata call, no LLM cost). default
   * true. best-effort: if inspect fails/parse-fails, usage is omitted (never
   * throws). set false to skip the extra exec.
   */
  fetchUsage?: boolean;
}

// default exec: the ONLY place this backend actually shells out. execa
// captures stdout only, and paseo writes its "Created workspace..." chatter to
// STDERR, so what we parse is clean.
const defaultPaseoExec: PaseoExec = async (args) => {
  const { stdout } = await execa("paseo", args);
  return stdout;
};

// paseo statuses that mean "the run did not finish clean". a clean run reports
// status "completed" (paseo maps an idle finish to "completed").
const FAILURE_STATUSES = new Set(["error", "timeout", "permission", "failed", "cancelled"]);

export class PaseoBackend extends AgentBackend {
  private readonly exec: PaseoExec;
  private readonly defaultProvider: string;
  private readonly defaultModel?: string;
  private readonly defaultEffort?: string;
  private readonly defaultMode?: string;
  private readonly defaultFeatureValues?: Record<string, unknown>;
  private readonly waitTimeout?: string;
  private readonly cwd?: string;
  private readonly workspaceId?: string;
  private readonly fetchUsage: boolean;

  constructor(opts: PaseoBackendOptions = {}) {
    super();
    this.exec = opts.exec ?? defaultPaseoExec;
    this.defaultProvider = opts.defaultProvider ?? "claude";
    this.defaultModel = opts.defaultModel;
    this.defaultEffort = opts.defaultEffort;
    this.defaultMode = opts.defaultMode;
    this.defaultFeatureValues = opts.defaultFeatureValues;
    this.waitTimeout = opts.waitTimeout;
    this.cwd = opts.cwd;
    this.workspaceId = opts.workspaceId;
    this.fetchUsage = opts.fetchUsage ?? true;
  }

  override get name(): string {
    return "paseo";
  }

  /**
   * build the `paseo run` argv. NOTE: no --output-schema (engine owns schema).
   * `--` goes right before the prompt so a ticket prompt that itself starts
   * with "-" (e.g. "-h flag missing from header") can't be mis-parsed as a
   * flag (same fix as buildPaseoArgs).
   */
  buildArgs(spec: AgentSpec): string[] {
    const args = ["run", "--json", "--provider", spec.provider ?? this.defaultProvider];
    const model = spec.model ?? this.defaultModel;
    if (model) args.push("--model", model);
    const effort = (spec.effort ?? this.defaultEffort)?.toString().trim();
    if (effort) args.push("--thinking", effort);
    const mode = (spec.mode ?? this.defaultMode)?.trim();
    if (mode) args.push("--mode", mode);
    const featureValues = {
      ...(this.defaultFeatureValues ?? {}),
      ...(spec.featureValues ?? {}),
    };
    for (const [key, value] of Object.entries(featureValues)) {
      if (value === undefined) continue;
      args.push("--feature", `${key}=${stringifyFeatureValue(value)}`);
    }
    // --worktree and --workspace are mutually exclusive in the CLI.
    if (spec.isolation === "worktree") {
      args.push("--worktree", worktreeName(spec));
    } else if (this.workspaceId) {
      args.push("--workspace", this.workspaceId);
    }
    if (this.waitTimeout) args.push("--wait-timeout", this.waitTimeout);
    if (this.cwd) args.push("--cwd", this.cwd);
    for (const [k, v] of Object.entries(spec.labels ?? {})) {
      args.push("--label", `${k}=${v}`);
    }
    args.push("--", spec.prompt);
    return args;
  }

  override async run(spec: AgentSpec): Promise<AgentResult> {
    // Fix H — a SANDBOXED script controls spec.provider/spec.model. A value like
    // "--worktree" or "-x" would inject a bare argv FLAG into `paseo run` (there
    // is no shell, so it is flag-injection, not shell-injection). Reject anything
    // that isn't a safe token BEFORE shelling out, so a script can't smuggle a
    // flag through provider/model (including backend defaults).
    const bad =
      flagLike(spec.provider) ??
      flagLike(spec.model) ??
      flagLike(this.defaultProvider) ??
      flagLike(this.defaultModel) ??
      (spec.isolation === "worktree" ? null : flagLike(this.workspaceId));
    if (bad != null)
      return {
        error: `paseo: unsafe provider/model/workspace value "${bad}" (flag-like or invalid)`,
      };
    try {
      const stdout = await this.exec(this.buildArgs(spec));
      const env = parsePaseoJson(stdout);
      if (!env) return { error: `paseo: could not parse --json output: ${clip(stdout)}` };
      if (env.status && FAILURE_STATUSES.has(env.status))
        return { error: `paseo: agent ended with status "${env.status}"` };

      // happy path when the envelope embeds text (future paseo / test mock).
      if (env.text != null) return { text: env.text, usage: env.usage };

      // real live path: envelope has agentId+status but NO text — recover the
      // final assistant message from the daemon timeline.
      if (env.agentId) {
        const transcript = await this.exec(["logs", "--filter", "text", env.agentId]);
        const text = extractLogsText(transcript);
        if (text == null) return { error: "paseo: no assistant text in agent timeline" };
        // Fix I — the run envelope carries no usage, so recover REAL token usage
        // from `paseo inspect` (LastUsage.OutputTokens). ?? only fires when the
        // envelope had none, so a mock/future envelope with usage skips inspect.
        const usage = env.usage ?? (await this.fetchUsageFor(env.agentId));
        return { text, usage };
      }
      return { error: "paseo: --json output had neither text nor agentId" };
    } catch (err) {
      // NEVER throw out of run() — infra failure (non-zero exit, daemon down,
      // timeout) becomes { error } so the engine maps it to agent()===null.
      return { error: `paseo exec failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // a one-shot `paseo run` holds no persistent handle (execa spawns + exits per
  // call), so there is nothing to release. documented no-op.
  override async dispose(): Promise<void> {}

  /**
   * Fix I — recover REAL token usage for a finished agent from `paseo inspect
   * --json <id>` (LastUsage.OutputTokens; parsePaseoJson already probes it).
   * BEST-EFFORT: gated by fetchUsage, and ANY failure (inspect errors / stdout
   * unparseable) returns undefined rather than throwing — a fictional budget is
   * better than a crashed run.
   */
  private async fetchUsageFor(agentId: string): Promise<AgentUsage | undefined> {
    if (!this.fetchUsage) return undefined;
    try {
      const out = await this.exec(["inspect", "--json", agentId]);
      return parsePaseoJson(out)?.usage;
    } catch {
      return undefined;
    }
  }
}

// ---- helpers ----

/**
 * worktree name from a spec — deterministic-ish + path/flag safe. paseo mints a
 * git worktree under this name, so keep it to [a-z0-9-] and cap the length.
 */
function worktreeName(spec: AgentSpec): string {
  const raw = spec.phase ?? spec.label ?? "agent";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `flow2-${slug || "agent"}`;
}

/** parsed shape of a `paseo run --json` completion envelope (as we consume it). */
export interface PaseoEnvelope {
  status?: string;
  agentId?: string;
  text?: string;
  usage?: AgentUsage;
}

/**
 * parse `paseo run --json` stdout. the REAL envelope = { agentId, status,
 * provider, cwd, title } (no text/usage). we still probe a set of text/usage
 * fields DEFENSIVELY so a mock/future envelope that DOES embed them works in a
 * single exec. returns null when stdout is not a JSON object at all.
 */
export function parsePaseoJson(stdout: string): PaseoEnvelope | null {
  const obj = extractJsonObject(stdout);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const env: PaseoEnvelope = {};
  if (typeof o.status === "string") env.status = o.status;
  if (typeof o.agentId === "string") env.agentId = o.agentId;
  const text = pickText(o);
  if (text != null) env.text = text;
  const outputTokens = pickOutputTokens(o);
  if (outputTokens != null) env.usage = { outputTokens };
  return env;
}

// probe common "final text" fields in priority order, then a messages[] array.
function pickText(o: Record<string, unknown>): string | null {
  for (const k of ["result", "output", "text", "response", "content", "message", "lastMessage"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const msgs = o.messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as Record<string, unknown> | null;
      if (!m) continue;
      const c = m.content ?? m.text;
      if (typeof c === "string" && c.length > 0) return c;
    }
  }
  return null;
}

// probe common "output tokens" fields (snake + camel + paseo's inspect shape).
function pickOutputTokens(o: Record<string, unknown>): number | undefined {
  const usage = o.usage as Record<string, unknown> | undefined;
  const tokens = o.tokens as Record<string, unknown> | undefined;
  const lastUsage = o.LastUsage as Record<string, unknown> | undefined;
  const cands: unknown[] = [
    usage?.output_tokens,
    usage?.outputTokens,
    tokens?.output,
    lastUsage?.OutputTokens,
  ];
  for (const c of cands) if (typeof c === "number" && Number.isFinite(c)) return c;
  return undefined;
}

/**
 * recover the final assistant text from a `paseo logs --filter text` transcript.
 * that transcript interleaves paseo's "[User] <prompt>" echo lines with the
 * assistant reply (rendered unprefixed). our engine ALWAYS instructs a JSON
 * reply, so the robust move is: grab the LAST balanced top-level JSON value in
 * the transcript — independent of paseo's role-prefix rendering.
 *
 * KNOWN LIMITATION (observed on a real run): log-scraping cleanly isolates the
 * reply ONLY for the STRUCTURED (JSON) path. a plain-text agent() reply has no
 * JSON to lock onto, so the fallback below (drop "[Role] ..." echo lines) can
 * NOT cleanly separate the final assistant message from the persona preamble +
 * echoed prompt paseo dumps into the transcript — such a reply may come back
 * with that noise prepended. agents-workflow's own flows are ALL structured (every real
 * agent() call carries a schema), so this is tolerable today.
 *
 * DEFERRED FIX (architecture-review item, NOT done here): the robust long-term
 * cure is to feed the engine's json-schema to paseo via `--output-schema` so
 * paseo returns a clean structured result instead of us scraping logs. that is
 * intentionally NOT implemented now — the engine currently OWNS schema and this
 * backend must not reuse the --output-schema path (that is runner.ts's job).
 */
export function extractLogsText(transcript: string): string | null {
  const t = transcript.trim();
  if (!t) return null;
  const json = lastJsonValue(t);
  if (json != null) return json;
  const kept = t.split("\n").filter((ln) => !/^\[[A-Za-z]/.test(ln.trim()));
  const joined = kept.join("\n").trim();
  return joined.length ? joined : t;
}

// scan the whole string, return the LAST substring that both brace-matches and
// JSON.parses. skips past each matched value so nested braces aren't rescanned.
function lastJsonValue(s: string): string | null {
  let result: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") {
      const end = matchBrace(s, i);
      if (end >= 0) {
        const cand = s.slice(i, end + 1);
        try {
          JSON.parse(cand);
          result = cand;
        } catch {
          /* not valid JSON — ignore this run */
        }
        i = end; // jump past this value
      }
    }
  }
  return result;
}

function stringifyFeatureValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

// pull the FIRST JSON object out of stdout. fast path: the whole (trimmed)
// string is JSON. otherwise scan for the first balanced {...} (defensive — the
// real paseo path is clean, but a stray banner line shouldn't break parsing).
function extractJsonObject(s: string): unknown {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* scan below */
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  const end = matchBrace(trimmed, start);
  if (end < 0) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

// forward balanced-delimiter scan from an opening { or [ to its match,
// respecting string literals + escapes. returns the close index, or -1 if
// unbalanced. same shape as engine.extractMeta's scanner.
function matchBrace(s: string, open: number): number {
  const openCh = s[open];
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// clip stdout for a readable error message.
function clip(s: string): string {
  const t = s.trim();
  return t.length > 120 ? t.slice(0, 117) + "..." : t;
}

// Fix H — return the offending value if it is UNSAFE as a `paseo run` argv
// token: starts with "-" (would read as a flag) OR holds any char outside the
// safe [A-Za-z0-9._/-] set. undefined/valid -> undefined (nothing to reject).
function flagLike(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  if (v.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(v)) return v;
  return undefined;
}
