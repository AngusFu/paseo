// ── HARD proof: zod z.fromJSONSchema digests EVERY built-in's inline schema ──
//
// the 10 Claude-Workflow-compat built-ins author INLINE JSON Schema (immutable
// contract). validation moved ajv -> zod (z.fromJSONSchema). this test extracts
// EVERY `const X_SCHEMA = {...}` literal from all 10 built-in flow files (source
// extraction, so conditionally-skipped phases are covered too, not just the
// paths a mock run happens to hit) and proves for EACH:
//   1. z.fromJSONSchema(schema) does NOT throw (no unsupported keyword), and
//   2. synthesize(schema) output PASSES the converted zod's safeParse.
// if fromJSONSchema ever chokes on a keyword a built-in uses, this fails LOUD
// with the exact file + schema name.
import { test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normalizeSchema, synthesize } from "../src/schema-normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN = path.join(__dirname, "..", "workflows", "builtin");

// balanced object-literal slice from the first '{' at/after `start`, skipping
// quoted spans (a description string may hold a stray brace). caveman brace count.
function sliceObject(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced object literal");
}

// extract every `const NAME_SCHEMA = { ... }` from one flow file. eval them IN
// SOURCE ORDER in one scope so a schema that references an earlier one in the
// same file resolves to the real obj.
function extractSchemas(src: string): Record<string, Record<string, unknown>> {
  const re = /const\s+(\w+_SCHEMA)\s*=\s*\{/g;
  const decls: string[] = [];
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const brace = src.indexOf("{", m.index);
    decls.push(`const ${m[1]} = ${sliceObject(src, brace)};`);
    names.push(m[1]);
  }
  const body = `"use strict";\n${decls.join("\n")}\nreturn {${names.join(",")}};`;
  return new Function(body)() as Record<string, Record<string, unknown>>;
}

test("z.fromJSONSchema digests EVERY inline schema across all 10 built-ins", () => {
  const files = fs.readdirSync(BUILTIN).filter((f) => f.endsWith(".flow.js"));
  expect(files.length).toBe(10);

  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(BUILTIN, f), "utf-8");
    const schemas = extractSchemas(src);
    expect(Object.keys(schemas).length, `${f} declared no *_SCHEMA`).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(schemas)) {
      // 1. conversion must not throw on any keyword the built-in uses.
      expect(
        () => z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]),
        `z.fromJSONSchema THREW on ${f}:${name} -> ${JSON.stringify(schema)}`,
      ).not.toThrow();
      // 2. synth output must pass the converted zod's OWN validate (mock/dry-run
      //    against this schema must not self-reject).
      const errs = normalizeSchema(schema).validate(synthesize(schema));
      expect(errs, `${f}:${name} synth self-rejected -> ${errs.join("; ")}`).toEqual([]);
      checked++;
    }
  }
  // sanity: we actually exercised the full known census (46 inline schemas).
  expect(checked).toBe(46);
});
