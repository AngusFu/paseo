// coverage gate. gates are the whole point of this tool, so the tool's
// own tests must prove they run - low coverage on the gate path fails
// the run, not just a warning.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // scope discovery to OUR OWN test dir. this is a shared-writer repo
    // (.claude/) - other sessions drop unrelated reference trees with
    // their own *.test.ts files (e.g. a vendored reference tree's own test/)
    // under this same flow2/ dir, and vitest's default glob would pick
    // those up too and fail on them (not our code, not our concern).
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        // cli.ts = process entry shell (argv parse, process.exit, stdout).
        // pure IO glue over already-tested engine/registry - drives no gate
        // logic. testing it means spawning subprocesses; not worth it.
        "src/cli.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
