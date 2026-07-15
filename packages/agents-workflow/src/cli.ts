#!/usr/bin/env node
/**
 * flowkit — deterministic workflow runner.
 *
 *   flowkit list
 *   flowkit run <name|path> [options]
 *   flowkit backends
 *
 * The CLI is backend-agnostic: `--backend` selects an AgentBackend via a
 * factory. Only `mock` ships today (deterministic dry-runs); a `paseo` backend
 * drops in by implementing AgentBackend and registering it in createBackend().
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createEngine } from "./engine.js";
import { AgentBackend } from "./backend.js";
import { MockBackend } from "./backends/mock.js";
import { PaseoBackend } from "./backends/paseo.js";
import { resolveWorkflow, listWorkflows } from "./registry.js";
import { Journal } from "./journal.js";
import { validateScript } from "./validator.js";
import {
  parseArgs,
  buildAgentArgs,
  ArgsError,
  resolveJournalPlan,
  applyRuntimeDefaults,
  type ParsedArgs,
} from "./cli-args.js";

/** Backend factory — the ONLY place concrete backends are wired in. */
function createBackend(name: string, opts: ParsedArgs): AgentBackend {
  switch (name) {
    case "mock": {
      const mode = (opts.mock as string) ?? "auto";
      if (mode === "empty") return new MockBackend({ respond: () => ({ text: "" }) });
      if (mode === "echo")
        return new MockBackend({ respond: (s) => ({ text: `[echo] ${s.label ?? "agent"}` }) });
      return new MockBackend({ respond: MockBackend.auto() });
    }
    case "paseo": {
      // real backend: runs each agent via the `paseo run` CLI. honors the
      // relevant `--` flags. engine still owns schema — this backend never
      // passes --output-schema.
      return new PaseoBackend({
        defaultProvider: (opts.provider as string) ?? undefined,
        waitTimeout: (opts.waitTimeout as string) ?? undefined,
        cwd: (opts.cwd as string) ?? undefined,
      });
    }
    default:
      throw new Error(`Unknown backend "${name}". Available: mock, paseo`);
  }
}

function usage(): string {
  return `flowkit — deterministic workflow runner

Usage:
  flowkit list                          List discoverable workflows
  flowkit run <name|path> [options]     Run a workflow
  flowkit validate <name|path>          Static-check a script (§11 belt)
  flowkit backends                      List available AgentBackends

Run options (kebab-case and camelCase both work, e.g. --wait-timeout ==
--waitTimeout; parsed by yargs-parser — see docs/cli.md for full conventions):
  --<key> <value>          Named arg, merged into the script's \`args\` global
                           (e.g. --ticketId X --runtimeDir /p --key k); wins
                           over --args on key collision. Valueless --<key> -> true.
  --args <json>            Base value for \`args\` (must be valid JSON). A bare
                           string/array (e.g. deep-research's prompt) only
                           works alone, with no --<key> flags to merge into it.
  --backend <name>         AgentBackend to use (default: mock; also: paseo)
  --mock <auto|empty|echo> Mock responder mode (default: auto = schema-synth)
  --provider <p>           paseo backend: default provider (default: claude)
  --wait-timeout <dur>     paseo backend: --wait-timeout (e.g. 30s, 5m, 1h)
  --cwd <path>             paseo backend: agent working directory
  --resume <journalPath>   Resume: serve unchanged agent() calls from this journal
  --journal <path>         Journal path (default ON: auto-derived, see docs)
  --no-journal             Disable journal writing
  --max-concurrency <n>    Cap concurrent backend.run calls (default: auto)
  --max-agents <n>         Cap total agent() calls (default: 1000)
  --budget <n>             Token budget; agent() throws when exceeded
  --no-strict              Allow Date.now()/Math.random() in scripts
  --trace                  Print each agent() dispatch to stderr
  --quiet                  Suppress phase/log trace

Sciforum flows (bug/feature/review) want just a ticketId — runtimeDir/key
default to ./.aw/<slug-of-ticketId>/ (override with AW_RUNTIME_DIR or
--runtimeDir/--key):
  aw run bug --ticketId SCIF-1234
  aw run bug --ticketId SCIF-1234 --runtimeDir /tmp/aw/x --key x
`;
}

async function cmdList(): Promise<void> {
  const wfs = listWorkflows();
  if (!wfs.length) {
    console.log("No workflows found.");
    return;
  }
  for (const w of wfs) {
    console.log(`${w.name.padEnd(16)} [${w.origin}]  ${(w.meta.description as string) ?? ""}`);
  }
}

// §11 static belt: scan a script for dangerous patterns and print any hits.
// exit 1 when violations found, 0 when clean.
async function cmdValidate(args: ParsedArgs): Promise<void> {
  const target = args._[1];
  if (!target) {
    console.error(usage());
    process.exit(2);
  }
  const wf = resolveWorkflow(target);
  const res = validateScript(wf.source);
  if (res.ok) {
    console.log(`✔ ${wf.name}: no violations (${wf.path})`);
    return;
  }
  console.error(`✗ ${wf.name}: ${res.violations.length} violation(s) (${wf.path})`);
  for (const v of res.violations) {
    console.error(`  [${v.rule}] @${v.index}: ${v.snippet}`);
  }
  process.exit(1);
}

async function cmdBackends(): Promise<void> {
  console.log("mock     reference AgentBackend (deterministic dry-runs; ships today)");
  console.log("paseo    runs each agent via the `paseo run` CLI against a local daemon");
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const target = args._[1];
  if (!target) {
    console.error(usage());
    process.exit(2);
  }

  const wf = resolveWorkflow(target);
  const quiet = Boolean(args.quiet);
  const trace = Boolean(args.trace);
  const err = (m: string): void => {
    if (!quiet) process.stderr.write(m + "\n");
  };

  err(`▸ workflow: ${wf.name}  [${wf.origin}]  ${wf.path}`);

  // args: --args json base, overlaid by named --<key> flags (named wins).
  let agentArgs: unknown;
  try {
    agentArgs = buildAgentArgs(args);
  } catch (e) {
    if (e instanceof ArgsError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }

  // runtimeDir/key are OPTIONAL: fill them in when agentArgs is an object
  // and they weren't given (deep-research's bare-string args pass through
  // untouched — see applyRuntimeDefaults). print so the user knows where
  // artifacts/journal are landing.
  agentArgs = applyRuntimeDefaults(agentArgs, {
    env: process.env,
    cwd: process.cwd(),
    now: Date.now(),
  });
  if (agentArgs !== null && typeof agentArgs === "object" && !Array.isArray(agentArgs)) {
    const obj = agentArgs as Record<string, unknown>;
    if (typeof obj.runtimeDir === "string" && typeof obj.key === "string") {
      err(`▸ runtime: ${path.join(obj.runtimeDir, obj.key)}`);
    }
  }

  // journal: ON by default (stable derived path, so --resume works across
  // runs); --journal picks the path, --no-journal turns it off, --resume
  // replays a journal without wiping it. NOTE: `--no-journal` collapses onto
  // `args.journal === false` (yargs-parser negation, see cli-args.ts) — it
  // does not produce a separate `noJournal` key.
  const journalRaw = args.journal as string | boolean | undefined;
  const plan = resolveJournalPlan({
    journalFlag: typeof journalRaw === "string" ? journalRaw : undefined,
    noJournal: journalRaw === false,
    resumeFlag: args.resume as string | boolean | undefined,
    agentArgs,
    cwd: process.cwd(),
    workflowName: wf.name,
  });
  if (plan.path) {
    fs.mkdirSync(path.dirname(path.resolve(plan.path)), { recursive: true });
    if (plan.wipeIfExists && fs.existsSync(plan.path)) fs.rmSync(plan.path);
    err(`▸ journal: ${plan.path}`);
  }
  const journal = new Journal({ path: plan.path });
  if (args.resume) err(`▸ resuming from journal: ${args.resume} (${journal.size} cached)`);

  const backend = createBackend((args.backend as string) ?? "mock", args);

  const engine = createEngine({
    backend,
    journal,
    maxConcurrency: args.maxConcurrency ? Number(args.maxConcurrency) : undefined,
    agentCap: args.maxAgents ? Number(args.maxAgents) : undefined,
    budgetTokens: args.budget ? Number(args.budget) : null,
    strict: args.strict !== false,
    onPhase: (p) => err(`\n═══ Phase: ${p} ═══`),
    onLog: (m) => err(`  ${m}`),
  });

  if (trace) {
    const orig = backend.run.bind(backend);
    backend.run = async (spec) => {
      err(
        `  → agent [${spec.label ?? "?"}] phase=${spec.phase ?? "-"} provider=${spec.provider ?? "-"} model=${spec.model ?? "-"}`,
      );
      return orig(spec);
    };
  }

  const start = Date.now();
  const { meta, result, stats, budget } = await engine.run(wf.source, { args: agentArgs });

  err(
    `\n✔ done in ${Date.now() - start}ms · agents=${stats.agentCalls} cacheHits=${stats.cacheHits} retries=${stats.structuredRetries}` +
      (budget.total != null ? ` · tokens=${budget.spent}/${budget.total}` : ""),
  );
  err(`  meta.phases: ${(meta.phases ?? []).map((p) => p.title).join(" → ") || "(none)"}`);

  // final result to stdout as JSON
  process.stdout.write(
    JSON.stringify({ workflow: wf.name, meta, result, stats, budget }, null, 2) + "\n",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case "list":
        return await cmdList();
      case "backends":
        return await cmdBackends();
      case "validate":
        return await cmdValidate(args);
      case "run":
        return await cmdRun(args);
      case undefined:
      case "help":
      case "--help":
        console.log(usage());
        return;
      default:
        console.error(`Unknown command "${cmd}".\n\n` + usage());
        process.exit(2);
    }
  } catch (e) {
    console.error("error: " + (e as Error).message);
    process.exit(1);
  }
}

main();
