// LIVE smoke for PaseoBackend — gated behind FLOW2_PASEO_LIVE=1, SKIPPED by
// default so `pnpm test` stays deterministic/offline.
//
// caveman law: this file lives ALONE (separate from backends-paseo.test.ts) on
// purpose. that file module-mocks execa for its deterministic unit tests; a
// "live" test in the same file would silently get the MOCKED execa and never
// touch the real daemon — a false-green trap. HERE there is NO execa mock, so a
// real PaseoBackend shells out to a real `paseo run` against a real daemon.
//
// requires: a running paseo daemon + a working `claude` provider. run with:
//   FLOW2_PASEO_LIVE=1 pnpm test backends-paseo.live
import { expect, it } from "vitest";
import { PaseoBackend } from "../src/backends/paseo.js";
import { createEngine } from "../src/engine.js";

const LIVE = process.env.FLOW2_PASEO_LIVE === "1";

(LIVE ? it : it.skip)(
  "live smoke: real PaseoBackend runs a 1-agent workflow end-to-end",
  async () => {
    const backend = new PaseoBackend({ waitTimeout: "2m" });
    const engine = createEngine({ backend });
    const wf =
      'export const meta = { name: "live" };\nreturn await agent("Reply with exactly the single word: pong", { label: "ping" });';
    const { result } = await engine.run(wf);
    expect(String(result).toLowerCase()).toContain("pong");
  },
  180_000,
);
