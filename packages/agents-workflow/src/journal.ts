/**
 * Journal + resume cache.
 *
 * Every completed agent() call is recorded under a deterministic key derived
 * from (prompt, opts). On resume, calls whose key already has a cached result
 * return instantly without hitting the backend — mirroring Claude's
 * "unchanged (prompt, opts) prefix returns cached" resume protocol.
 *
 * In-memory by default; optionally mirrored to a JSONL file.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { schemaFingerprint, type SchemaInput } from "./schema-normalize.js";

export interface AgentKeyOpts {
  schema?: SchemaInput;
  model?: string;
  effort?: string;
  mode?: string;
  fast?: boolean;
  featureValues?: Record<string, unknown>;
  provider?: string;
  agentType?: string;
  // Finding 6 — these were MISSING from the key. two calls that differ ONLY in
  // label / phase must NOT share a cache slot.
  label?: string;
  phase?: string;
  // review 2026-07-18 — isolation/labels were also missing. NOTE: the engine
  // passes the RESOLVED phase (opts.phase ?? active phase()) so a global
  // phase() change invalidates the slot too.
  isolation?: string;
  labels?: Record<string, string>;
}

export function agentKey(prompt: string, opts: AgentKeyOpts = {}): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      prompt,
      // Finding 3 — fingerprint off the CANONICAL json shape, NOT the raw zod
      // instance (its bytes collide across different schemas -> wrong cache hit).
      schema: opts.schema != null ? fingerprint(opts.schema) : null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      mode: opts.mode ?? null,
      fast: opts.fast ?? null,
      featureValues: opts.featureValues ?? null,
      provider: opts.provider ?? null,
      agentType: opts.agentType ?? null,
      label: opts.label ?? null,
      phase: opts.phase ?? null,
      isolation: opts.isolation ?? null,
      labels: opts.labels ?? null,
    }),
  );
  return "wf_" + h.digest("hex").slice(0, 16);
}

// best-effort canonical fingerprint. a malformed schema that trips the seam
// falls back to a raw stringify so key-building never throws mid-run.
function fingerprint(schema: SchemaInput): string {
  try {
    return schemaFingerprint(schema);
  } catch {
    return JSON.stringify(schema) ?? "null";
  }
}

export interface JournalOptions {
  path?: string | null;
}

interface JournalRecord {
  key: string;
  result: unknown;
}

export class Journal {
  readonly path: string | null;
  private readonly cache = new Map<string, unknown>();
  // keys eligible for replay in the CURRENT run — snapshotted by beginRun().
  // Claude's resume serves results from a PRIOR run only; entries recorded
  // during the live run must NOT short-circuit later identical calls (judge
  // panels / refuter votes rely on identical prompts running independently).
  private replayable: Set<string>;

  constructor({ path = null }: JournalOptions = {}) {
    this.path = path;
    if (path && fs.existsSync(path)) this._load(path);
    this.replayable = new Set(this.cache.keys());
  }

  private _load(path: string): void {
    const lines = fs.readFileSync(path, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as JournalRecord;
        this.cache.set(rec.key, rec.result);
      } catch {
        /* skip corrupt line */
      }
    }
  }

  /** Snapshot the current entries as the replayable set for a starting run. */
  beginRun(): void {
    this.replayable = new Set(this.cache.keys());
  }

  /** True when `key` was recorded BEFORE the current run started (resume hit). */
  canReplay(key: string): boolean {
    return this.replayable.has(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
  get<T = unknown>(key: string): T {
    return this.cache.get(key) as T;
  }

  record(key: string, result: unknown): void {
    this.cache.set(key, result);
    if (this.path) fs.appendFileSync(this.path, JSON.stringify({ key, result }) + "\n");
  }

  get size(): number {
    return this.cache.size;
  }
}
