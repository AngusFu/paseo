/**
 * Schema seam — ONE normalization point for the engine's structured loop.
 *
 * agent(prompt, { schema }) accepts EITHER form:
 *   - a zod schema (agents-workflow native)          -> z.toJSONSchema + safeParse
 *   - a plain JSON Schema object (Claude Workflow)   -> z.fromJSONSchema + safeParse
 *
 * normalizeSchema() flattens both to the same pair:
 *   { jsonSchema, validate } — engine feeds jsonSchema to the prompt/persona +
 *   mock synth, and validate() to check the agent reply. FULLY zod now, zero
 *   third-party schema deps: zod owns BOTH branches (native JSON Schema interop
 *   converts the built-ins' inline JSON Schema into a zod schema on the fly).
 *
 * tryParseJson (tolerant extractor) and synthesize (mock stub generator) are
 * plain parsers/generators, NOT validators — they stay.
 */
import { z } from "zod";

/** What agent()'s `schema` opt may be: a zod type OR a raw JSON Schema object. */
export type SchemaInput = z.ZodType | Record<string, unknown>;

/** Flattened result: json shape for the prompt, validate() for the reply. */
export interface NormalizedSchema {
  /** JSON Schema object — fed to the persona + the mock synth. */
  jsonSchema: Record<string, unknown>;
  /** Check a value; returns human error strings (empty = valid). */
  validate(value: unknown): string[];
}

/** True when the schema is a zod type (agents-workflow native form). */
function isZod(schema: SchemaInput): schema is z.ZodType {
  return schema instanceof z.ZodType;
}

// ONE zod-error mapper for BOTH branches -> "$.a.b: message" (human, path-anchored).
function zodErrs(zs: z.ZodType, value: unknown): string[] {
  const res = zs.safeParse(value);
  if (res.success) return [];
  return res.error.issues.map((i) => `${["$", ...i.path].join(".")}: ${i.message}`);
}

/**
 * Normalize either schema form to { jsonSchema, validate } — both zod-backed.
 * zod branch: z.toJSONSchema derives the persona shape; safeParse validates.
 * JSON-Schema-object branch: keep the ORIGINAL object for the persona (preserve
 * the built-in's authored schema text), and z.fromJSONSchema converts it to a
 * zod schema that safeParse validates against.
 */
export function normalizeSchema(schema: SchemaInput): NormalizedSchema {
  if (isZod(schema)) {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    return { jsonSchema, validate: (value) => zodErrs(schema, value) };
  }
  // raw JSON Schema object: keep it verbatim for the persona, convert to zod
  // (native interop) for validation. one compile up front, reused per attempt.
  const jsonSchema = schema;
  const zs = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  return { jsonSchema, validate: (value) => zodErrs(zs, value) };
}

// Finding 3 — STABLE schema fingerprint for the journal key. zod instances
// stringify to near-identical opaque bytes (`.shape` is a dropped getter), so
// two DIFFERENT zod schemas collided on one journal key -> wrong cache hit /
// validation bypass. fingerprint off the CANONICAL json shape instead: zod ->
// z.toJSONSchema, raw JSON Schema -> itself. same seam normalizeSchema uses,
// but no zod compile (we only need the shape string, not a validator).
export function schemaFingerprint(schema: SchemaInput): string {
  const json = isZod(schema) ? z.toJSONSchema(schema) : schema;
  return JSON.stringify(json) ?? "null";
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; err: string };

/** Tolerant JSON extraction: raw parse, else code fence, else first balanced {...} or [...]. */
export function tryParseJson(text: unknown): ParseResult {
  if (typeof text !== "string") return { ok: false, err: "non-string response" };
  const trimmed = text.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return { ok: true, value: JSON.parse(fence[1].trim()) };
    } catch {
      /* fall through */
    }
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    if (start < 0) continue;
    let depth = 0,
      inStr = false,
      esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return { ok: true, value: JSON.parse(trimmed.slice(start, i + 1)) };
          } catch {
            break;
          }
        }
      }
    }
  }
  return { ok: false, err: "no JSON found" };
}

// minimal shape synth reads off a normalized jsonSchema. NOT a validator type
// (zod owns validation) — just the keys synth needs to fabricate a stub.
interface SchemaShape {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaShape>;
  items?: SchemaShape;
  minItems?: number;
  min?: number;
  minimum?: number;
  // Finding 7 — synth must honor these STANDARD keywords too, or it emits a
  // stub its OWN validate() rejects (a mock/dry-run then returns null).
  exclusiveMinimum?: number;
  minLength?: number;
  pattern?: string;
}

// smallest number that satisfies a numeric floor. exclusiveMinimum wins (must
// be strictly greater -> +1); else standard `minimum`; else legacy `min`; else 0.
function numFloor(s: SchemaShape): number {
  if (typeof s.exclusiveMinimum === "number") return s.exclusiveMinimum + 1;
  return s.minimum ?? s.min ?? 0;
}

/**
 * Synthesize a minimal valid instance of a (normalized) json schema. Used by
 * dry-run/mock backends to produce real-shaped structured output without a
 * real agent. Works for BOTH schema branches since it reads jsonSchema.
 */
export function synthesize(schema: unknown): unknown {
  const s = schema as SchemaShape | undefined;
  if (!s) return {};
  if (s.enum && s.enum.length) return s.enum[0];
  switch (s.type) {
    case "string": {
      // Finding 7 — a bare "stub" (4 chars) fails minLength; pad it up. a
      // `pattern` we can NOT satisfy in general (arbitrary regex) - documented
      // limitation: synth does not fabricate pattern-matching strings, so a
      // pattern-carrying string schema may still fail its own validate().
      let v = "stub";
      if (typeof s.minLength === "number" && v.length < s.minLength) v = v.padEnd(s.minLength, "x");
      return v;
    }
    // Finding 7 — read STANDARD `minimum`/`exclusiveMinimum` (zod fromJSONSchema
    // honors those; the non-standard `min` is ignored). exclusiveMinimum needs strictly-greater
    // so bump by 1. `min` kept only as a last-ditch legacy fallback.
    case "number":
      return numFloor(s);
    case "integer":
      return numFloor(s);
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const n = Math.max(s.minItems ?? 0, 1);
      return Array.from({ length: n }, () => synthesize(s.items));
    }
    case "object":
    case undefined: {
      const obj: Record<string, unknown> = {};
      const props = s.properties ?? {};
      for (const k of s.required ?? []) obj[k] = synthesize(props[k]);
      // also include any non-required props for a fuller stub
      for (const [k, sub] of Object.entries(props)) if (!(k in obj)) obj[k] = synthesize(sub);
      return obj;
    }
    default:
      return {};
  }
}
