// ── the ARTIFACT-FULFILLING mock backend ──
//
// why it exists: MockBackend.auto() returns a schema-valid JSON reply but never
// WRITES the artifact FILE the two-layer gate checks. so a GATED agent() call
// (opts.artifact set) always BlockedErrors under the plain auto mock — the file
// it named does not exist. this helper is the realistic harness for gated
// flows: for every reply whose envelope carries an `artifact` path, it WRITES a
// non-empty file at <runtimeDir>/<key>/outputs/<artifact> BEFORE returning, so
// the gate finds real bytes and passes. it also lets a test STEER enum fields
// (triage.tier, rca.attribution, ...) per phase label to drive each branch.
//
// this is a TEST helper (lives under test/, excluded from src coverage). it
// does NOT weaken any gate — it does the real work a real agent would: it
// leaves real output bytes on disk. the gate still runs unchanged.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MockBackend } from "../../src/backends/mock.js";
import { synthesize } from "../../src/schema-normalize.js";
import type { AgentSpec } from "../../src/backend.js";

export interface FulfillingOpts {
  /** sandbox root — same runtimeDir the flow passes as args.runtimeDir. */
  runtimeDir: string;
  /** run key — same key the flow passes as args.key. */
  key: string;
  /** per-label field overrides merged into the synthesized envelope. */
  fields?: Record<string, Record<string, unknown>>;
  /** per-label artifact filename (defaults to `<label>.md`). */
  artifactNames?: Record<string, string>;
}

// pull the JSON Schema block the engine's structuredPersona embedded in the
// prompt (same regex MockBackend.auto uses). null when the call is unstructured.
function schemaFromPrompt(prompt: string): Record<string, unknown> | null {
  const m = /JSON Schema:\s*\n([\s\S]*?)(?:\n\n---|$)/.exec(prompt);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build a MockBackend that fulfills gated artifacts. For each structured reply:
 *   1. synthesize a schema-valid instance,
 *   2. merge any per-label field overrides (steer enums / booleans),
 *   3. if the instance has a string `artifact`, pick its filename
 *      (artifactNames[label] or `<label>.md`), set it, and WRITE a real
 *      non-empty file at <runtimeDir>/<key>/outputs/<filename>,
 *   4. return the instance as JSON text.
 * Unstructured calls fall back to a short stub string.
 */
export function fulfillingBackend(opts: FulfillingOpts): MockBackend {
  const outputs = path.join(opts.runtimeDir, opts.key, "outputs");
  const fields = opts.fields ?? {};
  const artifactNames = opts.artifactNames ?? {};

  const respond = (spec: AgentSpec): { text: string } => {
    const schema = schemaFromPrompt(spec.prompt);
    if (!schema) return { text: "stub" };
    const obj = synthesize(schema) as Record<string, unknown>;
    const label = spec.label ?? "agent";
    // steer enum/boolean fields for this phase (e.g. tier, attribution).
    if (fields[label]) Object.assign(obj, fields[label]);
    // envelope carries an artifact path -> materialize a real file on disk so
    // the gate (which reads that exact path) passes.
    if (typeof obj.artifact === "string") {
      const filename = artifactNames[label] ?? `${label}.md`;
      obj.artifact = filename;
      mkdirSync(outputs, { recursive: true });
      writeFileSync(
        path.join(outputs, filename),
        `# ${label}\n\nfulfilled by the test harness for ${spec.phase ?? "-"}\n`,
      );
    }
    return { text: JSON.stringify(obj) };
  };

  return new MockBackend({ respond });
}
