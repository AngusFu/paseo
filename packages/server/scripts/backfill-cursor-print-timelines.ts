/**
 * Offline backfill: rebuild durable Paseo timelines for cursor-print agents from
 * Cursor agent-transcripts (preferred) and/or store.db history.
 *
 * Default is dry-run. Pass --apply to write `$PASEO_HOME/agent-timelines/{id}.json`.
 * Restart the daemon afterward so in-memory timelines reseed from disk.
 */
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentTimelineItem } from "../src/server/agent/agent-sdk-types.js";
import { FileAgentTimelineStore } from "../src/server/agent/durable-agent-timeline-store.js";
import { readCursorPrintTimelineHistory } from "../src/server/agent/providers/cursor-print-sessions.js";
import { readCursorPrintTranscriptTimeline } from "../src/server/agent/providers/cursor-print-transcripts.js";

interface AgentRecord {
  id: string;
  provider?: string;
  cwd?: string;
  archivedAt?: string | null;
  updatedAt?: string;
  title?: string | null;
  persistence?: { sessionId?: string | null } | null;
  runtimeInfo?: { sessionId?: string | null } | null;
}

interface CliOptions {
  apply: boolean;
  force: boolean;
  agentPrefix: string | null;
  limit: number | null;
  paseoHome: string;
  cursorHome: string;
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let force = false;
  let agentPrefix: string | null = null;
  let limit: number | null = null;
  let paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  let cursorHome = process.env.HOME?.trim() || homedir();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--agent") {
      agentPrefix = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      i += 1;
      continue;
    }
    if (arg === "--paseo-home") {
      paseoHome = argv[i + 1] ?? paseoHome;
      i += 1;
      continue;
    }
    if (arg === "--cursor-home") {
      cursorHome = argv[i + 1] ?? cursorHome;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { apply, force, agentPrefix, limit, paseoHome, cursorHome };
}

function printHelp(): void {
  process.stdout.write(`Usage: backfill-cursor-print-timelines [options]

Rebuild durable timelines for cursor-print agents from Cursor transcripts / store.db.

Options:
  --apply              Write agent-timelines (default: dry-run)
  --force              Overwrite even when existing durable rows are longer
  --agent <id|prefix>  Only process matching agent id
  --limit <n>          Process at most n agents
  --paseo-home <path>  Override PASEO_HOME (default: env or ~/.paseo)
  --cursor-home <path> Home dir used to find ~/.cursor/projects
  -h, --help           Show help
`);
}

function resolveSessionId(record: AgentRecord): string | null {
  const fromPersistence = record.persistence?.sessionId;
  if (typeof fromPersistence === "string" && fromPersistence.trim()) {
    return fromPersistence.trim();
  }
  const fromRuntime = record.runtimeInfo?.sessionId;
  if (typeof fromRuntime === "string" && fromRuntime.trim()) {
    return fromRuntime.trim();
  }
  return null;
}

async function listAgentJsonFiles(agentsRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(path);
      }
    }
  }
  await walk(agentsRoot);
  return out;
}

async function loadCursorPrintAgents(paseoHome: string): Promise<AgentRecord[]> {
  const files = await listAgentJsonFiles(join(paseoHome, "agents"));
  const agents: AgentRecord[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as AgentRecord;
      if (parsed.provider !== "cursor-print" || typeof parsed.id !== "string") {
        continue;
      }
      agents.push(parsed);
    } catch {
      // skip malformed
    }
  }
  agents.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return agents;
}

function countByType(items: readonly AgentTimelineItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}

function pickRicherTimeline(
  transcript: AgentTimelineItem[],
  store: AgentTimelineItem[],
): { items: AgentTimelineItem[]; source: "transcript" | "store.db" | "none" } {
  if (transcript.length === 0 && store.length === 0) {
    return { items: [], source: "none" };
  }
  if (transcript.length >= store.length) {
    return { items: transcript, source: "transcript" };
  }
  return { items: store, source: "store.db" };
}

function toRows(items: readonly AgentTimelineItem[]): Array<{
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
}> {
  const timestamp = new Date().toISOString();
  return items.map((item, index) => ({
    seq: index + 1,
    timestamp,
    item,
  }));
}

async function daemonPidPresent(paseoHome: string): Promise<boolean> {
  try {
    await access(join(paseoHome, "paseo.pid"));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const store = new FileAgentTimelineStore(join(options.paseoHome, "agent-timelines"));
  let agents = await loadCursorPrintAgents(options.paseoHome);
  if (options.agentPrefix) {
    const prefix = options.agentPrefix;
    agents = agents.filter((agent) => agent.id.startsWith(prefix));
  }
  if (options.limit != null) {
    agents = agents.slice(0, options.limit);
  }

  process.stdout.write(
    `paseoHome=${options.paseoHome} apply=${options.apply} force=${options.force} agents=${agents.length}\n`,
  );
  if (await daemonPidPresent(options.paseoHome)) {
    process.stdout.write(
      "warning: paseo.pid present — restart the daemon after --apply so memory reseeds from disk\n",
    );
  }

  let wrote = 0;
  let skipped = 0;
  let empty = 0;
  let failed = 0;

  for (const agent of agents) {
    const sessionId = resolveSessionId(agent);
    const cwd = typeof agent.cwd === "string" ? agent.cwd : "";
    const label = `${agent.id.slice(0, 8)} ${agent.archivedAt ? "arch" : "live"} ${(agent.title ?? "").slice(0, 40)}`;
    if (!sessionId || !cwd) {
      process.stdout.write(`FAIL  ${label} missing sessionId/cwd\n`);
      failed += 1;
      continue;
    }

    try {
      const [transcriptItems, storeItems] = await Promise.all([
        readCursorPrintTranscriptTimeline({
          sessionId,
          homeDir: options.cursorHome,
          env: {},
        }),
        readCursorPrintTimelineHistory({
          cwd,
          sessionId,
          homeDir: options.cursorHome,
          env: {},
        }),
      ]);
      const picked = pickRicherTimeline(transcriptItems, storeItems);
      const existing = await store.getCommittedRows(agent.id);

      if (picked.items.length === 0) {
        process.stdout.write(`EMPTY ${label} transcript=0 store=0\n`);
        empty += 1;
        continue;
      }

      if (!options.force && existing.length >= picked.items.length) {
        process.stdout.write(
          `SKIP  ${label} existing=${existing.length} candidate=${picked.items.length} source=${picked.source}\n`,
        );
        skipped += 1;
        continue;
      }

      const counts = countByType(picked.items);
      process.stdout.write(
        `${options.apply ? "WRITE" : "PLAN "} ${label} items=${picked.items.length} source=${picked.source} existing=${existing.length} types=${JSON.stringify(counts)}\n`,
      );

      if (options.apply) {
        await store.deleteAgent(agent.id);
        await store.bulkInsert(agent.id, toRows(picked.items));
        wrote += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`FAIL  ${label} ${message}\n`);
      failed += 1;
    }
  }

  process.stdout.write(
    `done wrote=${wrote} skipped=${skipped} empty=${empty} failed=${failed} mode=${options.apply ? "apply" : "dry-run"}\n`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
