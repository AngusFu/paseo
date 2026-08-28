import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";

import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { applyDshRuntimeEnv } from "./dsh-credentials.js";
import {
  JsonRpcLineTransport,
  type JsonRpcLaunch,
  type JsonRpcNotification,
} from "./jsonrpc-transport.js";

export interface DshContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface DshStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  dshHome?: string;
  runtimeBin?: string;
  cordis?: string;
  sessionRoot?: string;
  nodeModulesPaths?: string[];
}

export interface DshRuntimeLaunch {
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DshRuntimeSession {
  onNotification(callback: (notification: JsonRpcNotification) => void): () => void;
  onExit(callback: (error: Error) => void): () => void;
  initialize(params: DshInitializeParams): Promise<void>;
  prompt(sessionId: string, contentBlocks: DshContentBlock[]): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export interface DshRuntime {
  startSession(input: DshStartSessionInput): Promise<DshRuntimeSession>;
}

export function buildDshLaunch(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  session: DshStartSessionInput;
}): DshRuntimeLaunch {
  const resolvedBin = resolveDshRuntimeBin({
    runtimeSettings: input.runtimeSettings,
    runtimeBin: input.session.runtimeBin,
  });
  const env: Record<string, string> = {
    ...input.runtimeSettings?.env,
    ...input.session.env,
  };

  const cordis = resolveDshCordis({
    cordis: input.session.cordis,
    runtimeBin: resolvedBin,
    env,
  });
  if (cordis) {
    env.DSH_CORDIS_CONFIG = cordis;
  }
  if (input.session.sessionRoot) {
    env.DSH_SESSION_ROOT = input.session.sessionRoot;
  }
  env.DSH_CWD = input.session.cwd;

  if (input.session.nodeModulesPaths?.length) {
    const existing = env.NODE_PATH?.trim();
    const merged = [...input.session.nodeModulesPaths, ...(existing ? [existing] : [])].join(
      process.platform === "win32" ? ";" : ":",
    );
    env.NODE_PATH = merged;
  }

  applyDshRuntimeEnv(env, { dshHome: input.session.dshHome });

  return {
    cwd: input.session.cwd,
    command: resolvedBin,
    args: [],
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}

export function resolveDshRuntimeBin(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  runtimeBin?: string;
}): string {
  if (input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]) {
    return input.runtimeSettings.command.argv[0];
  }
  if (input.runtimeBin) {
    return input.runtimeBin;
  }
  const fromEnv = process.env.DSH_JSONRPC_AGENT?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return "dsh-jsonrpc-agent";
}

export function resolveDshCordis(input: {
  cordis?: string;
  runtimeBin: string;
  env: Record<string, string>;
}): string | undefined {
  if (input.cordis) {
    return input.cordis;
  }
  if (input.env.DSH_CORDIS_CONFIG) {
    return input.env.DSH_CORDIS_CONFIG;
  }
  const fromProcessEnv = process.env.DSH_CORDIS_CONFIG?.trim();
  if (fromProcessEnv) {
    return fromProcessEnv;
  }
  return findBundledCordisBesideRuntime(input.runtimeBin);
}

function findBundledCordisBesideRuntime(runtimeBin: string): string | undefined {
  if (!runtimeBin.includes("/") && !runtimeBin.includes("\\")) {
    return undefined;
  }
  const beside = join(dirname(runtimeBin), "cordis.yml");
  if (existsSync(beside)) {
    return beside;
  }
  return undefined;
}

export async function checkDshRuntimeAvailable(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  runtimeBin?: string;
}): Promise<boolean> {
  const command = resolveDshRuntimeBin(input);
  const launch = await resolveProviderLaunch({
    commandConfig: input.runtimeSettings?.command,
    defaultBinary: { command },
  });
  const availability = await checkProviderLaunchAvailable(launch, { command });
  return availability.available;
}

export interface DshCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  spawnProcess?: (launch: JsonRpcLaunch) => ReturnType<typeof import("node:child_process").spawn>;
}

export class DshCliRuntime implements DshRuntime {
  constructor(private readonly options: DshCliRuntimeOptions) {}

  async startSession(input: DshStartSessionInput): Promise<DshRuntimeSession> {
    const launch = buildDshLaunch({
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    const processLaunch: JsonRpcLaunch = {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    };
    const spawn = this.options.spawnProcess;
    const transport = new JsonRpcLineTransport({
      launch: processLaunch,
      logger: this.options.logger,
      diagnosticName: "DeepSeek Harness JSON-RPC",
      ...(spawn
        ? {
            spawn: (jsonLaunch) => {
              const child = spawn(jsonLaunch);
              if (!child.stdin || !child.stdout || !child.stderr) {
                throw new Error("DSH JSON-RPC process was spawned without stdio streams");
              }
              return child as import("node:child_process").ChildProcessWithoutNullStreams;
            },
          }
        : {}),
    });
    return new DshCliRuntimeSession(transport);
  }
}

class DshCliRuntimeSession implements DshRuntimeSession {
  constructor(private readonly transport: JsonRpcLineTransport) {}

  onNotification(callback: (notification: JsonRpcNotification) => void): () => void {
    return this.transport.onNotification(callback);
  }

  onExit(callback: (error: Error) => void): () => void {
    return this.transport.onExit((exit) => {
      callback(exit.error);
    });
  }

  async initialize(params: DshInitializeParams): Promise<void> {
    await this.transport.request("initialize", {
      cwd: params.cwd,
      provider: params.provider,
      model: params.model,
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    });
  }

  async prompt(sessionId: string, contentBlocks: DshContentBlock[]): Promise<string> {
    const result = await this.transport.request("session/prompt", {
      sessionId,
      contentBlocks,
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("DSH session/prompt returned an invalid result");
    }
    const messageId = (result as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string" || !messageId) {
      throw new Error("DSH session/prompt did not return a messageId");
    }
    return messageId;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async kill(): Promise<void> {
    await this.transport.kill();
  }
}
