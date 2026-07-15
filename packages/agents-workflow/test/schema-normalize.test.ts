// Swap 1: replaces flowkit's schema.test.ts. Proves the ONE seam handles BOTH
// schema forms (zod via safeParse, JSON-Schema object via z.fromJSONSchema ->
// safeParse) + keeps tryParseJson/synthesize (parsers, not validators).
import { test, expect } from "vitest";
import { z } from "zod";
import { normalizeSchema, tryParseJson, synthesize } from "../src/schema-normalize.js";

test("normalizeSchema: JSON-Schema object branch validates via z.fromJSONSchema", () => {
  const schema = {
    type: "object",
    required: ["summary", "bugs"],
    properties: {
      summary: { type: "string" },
      bugs: {
        type: "array",
        items: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
      },
    },
  };
  const n = normalizeSchema(schema);
  expect(n.jsonSchema).toBe(schema); // object branch hands the schema back as-is
  expect(n.validate({ summary: "x", bugs: [{ file: "a.js" }] })).toEqual([]);
  const errs = n.validate({ bugs: [{}] });
  expect(errs.join(" ")).toMatch(/summary/);
  expect(errs.join(" ")).toMatch(/file/);
});

test("normalizeSchema: JSON-Schema enum + type + additionalProperties", () => {
  expect(normalizeSchema({ enum: ["a", "b"] }).validate("a")).toEqual([]);
  expect(normalizeSchema({ enum: ["a", "b"] }).validate("c").length).toBeGreaterThan(0);
  expect(normalizeSchema({ type: "string" }).validate(5).length).toBeGreaterThan(0);
  const s = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  expect(normalizeSchema(s).validate({ a: "x", b: 1 }).length).toBeGreaterThan(0);
});

test("normalizeSchema: zod branch derives jsonSchema + validates via safeParse", () => {
  const schema = z.object({ ok: z.boolean(), n: z.number().min(1) });
  const n = normalizeSchema(schema);
  expect((n.jsonSchema as { type?: string }).type).toBe("object");
  expect(n.validate({ ok: true, n: 5 })).toEqual([]);
  const errs = n.validate({ ok: "nope", n: 0 });
  expect(errs.length).toBeGreaterThan(0);
  expect(errs.join(" ")).toMatch(/\$\./); // human "$.field: msg" shape
});

test("tryParseJson: raw, fenced, embedded, none, non-string", () => {
  expect((tryParseJson('{"a":1}') as { value: unknown }).value).toEqual({ a: 1 });
  expect((tryParseJson('```json\n{"a":2}\n```') as { value: unknown }).value).toEqual({ a: 2 });
  expect((tryParseJson('Sure! {"a":3} done') as { value: unknown }).value).toEqual({ a: 3 });
  expect((tryParseJson("[1,2,3] tail") as { value: unknown }).value).toEqual([1, 2, 3]);
  expect(tryParseJson("no json here").ok).toBe(false);
  expect(tryParseJson(42).ok).toBe(false);
});

test("synthesize: stubs every primitive + nested object/array + enum", () => {
  expect(synthesize({ type: "string" })).toBe("stub");
  expect(synthesize({ type: "number", min: 3 })).toBe(3);
  expect(synthesize({ type: "integer" })).toBe(0);
  expect(synthesize({ type: "boolean" })).toBe(false);
  expect(synthesize({ type: "null" })).toBe(null);
  expect(synthesize({ enum: ["x", "y"] })).toBe("x");
  expect(synthesize({ type: "array", minItems: 2, items: { type: "string" } })).toEqual([
    "stub",
    "stub",
  ]);
  expect(
    synthesize({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" }, b: { type: "boolean" } },
    }),
  ).toEqual({ a: "stub", b: false });
  expect(synthesize(undefined)).toEqual({});
  expect(synthesize({ type: "weird" })).toEqual({});
});

// ── Finding 7 (LOW) — synth used to ignore minLength/minimum/exclusiveMinimum
// (and read the non-standard `min` that ajv ignores), so a mock/dry-run against
// such a schema produced output the engine's OWN validate() rejected -> the
// structured loop returned null. synth output must pass the same validate().
test("Finding 7: synthesize honors minLength / minimum / exclusiveMinimum", () => {
  expect((synthesize({ type: "string", minLength: 8 }) as string).length).toBeGreaterThanOrEqual(8);
  expect(synthesize({ type: "integer", minimum: 3 })).toBe(3);
  expect(synthesize({ type: "number", exclusiveMinimum: 5 })).toBeGreaterThan(5);
});

test("Finding 7: validate(synthesize(s)) is empty for a minLength/minimum schema", () => {
  const s = {
    type: "object",
    required: ["name", "count"],
    properties: {
      name: { type: "string", minLength: 6 },
      count: { type: "integer", minimum: 3 },
    },
  };
  const n = normalizeSchema(s);
  expect(n.validate(synthesize(s))).toEqual([]); // synth output passes its OWN schema
});
