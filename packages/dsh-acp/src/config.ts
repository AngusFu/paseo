import { homedir } from "node:os";
import { join } from "node:path";

export interface DshAcpConfig {
  provider?: string;
  model?: string;
  runtimeBin?: string;
  cordis?: string;
  dshHome: string;
  sessionRoot: string;
  maxTokens?: number;
}

interface ParsedArgs {
  values: Map<string, string>;
  help: boolean;
  version: boolean;
}

const VALUE_OPTIONS = new Set([
  "--provider",
  "--model",
  "--runtime-bin",
  "--cordis",
  "--dsh-home",
  "--session-root",
  "--max-tokens",
]);

export function parseDshAcpConfig(argv: string[], env: NodeJS.ProcessEnv): DshAcpConfig {
  const parsed = parseArgs(argv);
  if (parsed.help || parsed.version) {
    throw new Error("Help and version flags must be handled before parsing configuration");
  }

  const value = (option: string, envName: string): string | undefined =>
    parsed.values.get(option) ?? normalizeEnvValue(env[envName]);
  const dshHome = value("--dsh-home", "DSH_HOME") ?? join(homedir(), ".dsh");
  const maxTokens = parseMaxTokens(value("--max-tokens", "DSH_MAX_TOKENS"));
  const cordis = value("--cordis", "DSH_CORDIS_CONFIG");
  return {
    ...(value("--provider", "DSH_PROVIDER")
      ? { provider: value("--provider", "DSH_PROVIDER") }
      : {}),
    ...(value("--model", "DSH_MODEL") ? { model: value("--model", "DSH_MODEL") } : {}),
    ...(value("--runtime-bin", "DSH_JSONRPC_AGENT")
      ? { runtimeBin: value("--runtime-bin", "DSH_JSONRPC_AGENT") }
      : {}),
    ...(cordis ? { cordis } : {}),
    dshHome,
    sessionRoot: value("--session-root", "DSH_SESSION_ROOT") ?? join(dshHome, "sessions"),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseMaxTokens(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const maxTokens = Number(value);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("--max-tokens must be a positive integer");
  }
  return maxTokens;
}

export function parseCliFlags(argv: string[]): { help: boolean; version: boolean } {
  const parsed = parseArgs(argv);
  return { help: parsed.help, version: parsed.version };
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }

  return { values, help, version };
}
