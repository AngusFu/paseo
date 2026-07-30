import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
  ProviderCatalog,
} from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../provider-launch-config.js";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import {
  deleteCursorPrintSession,
  findCursorPrintSessionDir,
  isCursorResumeFailure,
  listCursorPrintImportableSessions,
  readCursorPrintHistory,
  resolveAbsoluteWorkspace,
} from "./cursor-print-sessions.js";
import {
  mapCursorPrintToolCall,
  resolveAssistantEmitText,
  toToolCallTimelineItem,
} from "./cursor-print-mapper.js";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  isACPAutoAcceptEnabled,
  parseACPAutoAcceptFeatureValue,
} from "./acp-agent.js";
import { composeSystemPromptParts } from "../system-prompt.js";

export const CURSOR_PRINT_PROVIDER_ID = "cursor-print";
/** Prefer auto-review: many orgs disable --force / YOLO. */
export const CURSOR_PRINT_DEFAULT_MODE_ID = "auto-review";
const CURSOR_PRINT_DEFAULT_COMMAND = ["agent"] as const;
const MODELS_TIMEOUT_MS = 30_000;

/**
 * Cursor CLI has no --append-system-prompt. Paseo also cannot inject daemon MCP
 * into print sessions (`supportsMcpServers: false`). Prepend this guidance (plus
 * any agent/daemon system prompts) to the CLI prompt each turn; timeline
 * user_message stays the raw user text.
 */
export const CURSOR_PRINT_RUNTIME_GUIDANCE = [
  "Paseo cursor-print: no daemon MCP. Use Shell + project CLIs; do not wait for MCP tools.",
  "Prefer: atlassian (Jira/Confluence), glab (GitLab; use env -u GITLAB_TOKEN glab …), figma, chrome-devtools, gh.",
  "If a skill/doc names a CLI, run that CLI — do not substitute an MCP server.",
].join("\n");

/** Build the prompt string passed to `agent --print` (not the timeline user row). */
export function buildCursorPrintCliPrompt(
  userText: string,
  config: Pick<AgentSessionConfig, "systemPrompt" | "daemonAppendSystemPrompt"> = {},
): string {
  const preamble = composeSystemPromptParts(
    CURSOR_PRINT_RUNTIME_GUIDANCE,
    config.systemPrompt,
    config.daemonAppendSystemPrompt,
  );
  if (!preamble) {
    return userText;
  }
  const trimmed = userText.trim();
  if (!trimmed) {
    return preamble;
  }
  return `${preamble}\n\n---\n\n${trimmed}`;
}

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

export interface CursorPrintLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type CursorPrintSpawn = (launch: CursorPrintLaunch) => ChildProcessWithoutNullStreams;

export interface CursorPrintAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerId?: string;
  label?: string;
  spawn?: CursorPrintSpawn;
  execModels?: (command: string, args: string[], cwd: string) => Promise<string>;
}

interface PendingInteraction {
  requestId: string;
  queryId: number;
  queryType: string;
  request: AgentPermissionRequest;
}

interface ActiveTurn {
  turnId: string;
  assistantMessageId: string;
  assistantAccumulated: string;
  child: ChildProcessWithoutNullStreams | null;
  thinkingText: string;
  pendingInteractions: Map<string, PendingInteraction>;
  toolCallIds: Map<string, string>;
  completed: boolean;
  resumedWith: string | null;
  allowResumeFallback: boolean;
  /** Prompt passed to Cursor CLI (includes runtime guidance / system prompts). */
  promptText: string;
  /** Raw user text for timeline user_message / retries. */
  userText: string;
}

function isPlanLikePrintMode(modeId: string): boolean {
  return modeId === "plan" || modeId === "ask";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function normalizeModeId(modeId: string | null | undefined): string {
  const value = (modeId ?? CURSOR_PRINT_DEFAULT_MODE_ID).trim().toLowerCase();
  switch (value) {
    case "force":
    case "yolo":
      return "force";
    case "auto-review":
    case "auto":
    case "smart":
      return "auto-review";
    case "plan":
      return "plan";
    case "ask":
      return "ask";
    case "default":
      return "default";
    default:
      return CURSOR_PRINT_DEFAULT_MODE_ID;
  }
}

function parseModelsOutput(stdout: string, provider: AgentProvider): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "Available models" || line.startsWith("Tip:")) {
      continue;
    }
    const idx = line.indexOf(" - ");
    if (idx < 0) {
      continue;
    }
    const id = line.slice(0, idx).trim();
    let label = line.slice(idx + 3).trim();
    label = label.replace(/\s+\((?:current|default)\)$/i, "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({
      provider,
      id,
      label: label || id,
      isDefault: /\(current\)/i.test(line) || /\(default\)/i.test(line),
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
}

function mapUsage(raw: unknown): AgentUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    inputTokens: typeof raw.inputTokens === "number" ? raw.inputTokens : undefined,
    outputTokens: typeof raw.outputTokens === "number" ? raw.outputTokens : undefined,
    cachedInputTokens: typeof raw.cacheReadTokens === "number" ? raw.cacheReadTokens : undefined,
  };
}

function defaultSpawn(launch: CursorPrintLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    envOverlay: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("cursor-print process was spawned without stdio pipes");
  }
  return child as ChildProcessWithoutNullStreams;
}

export function buildTurnArgs(options: {
  extraArgs: string[];
  modeId: string;
  model: string | null;
  resumeChatId: string | null;
  workspace: string;
  prompt: string;
}): string[] {
  const workspace = resolveAbsoluteWorkspace(options.workspace);
  const args = [
    ...options.extraArgs,
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
  ];

  switch (options.modeId) {
    case "force":
      args.push("--force");
      break;
    case "auto-review":
      args.push("--auto-review");
      break;
    case "plan":
      args.push("--mode", "plan");
      break;
    case "ask":
      args.push("--mode", "ask");
      break;
    default:
      break;
  }

  if (options.resumeChatId) {
    args.push("--resume", options.resumeChatId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push("--workspace", workspace, "--", options.prompt);
  return args;
}

function withAbsoluteCwd(config: AgentSessionConfig): AgentSessionConfig {
  return {
    ...config,
    cwd: resolveAbsoluteWorkspace(config.cwd),
  };
}

export function buildCursorPrintAutoAcceptFeature(config: AgentSessionConfig): AgentFeature {
  return {
    type: "toggle",
    id: ACP_AUTO_ACCEPT_FEATURE_ID,
    label: "Auto Approve",
    description:
      "Automatically approves Cursor print/stream-json interaction_query tool permissions.",
    tooltip: "Auto approve Cursor print tool permissions",
    icon: "shield-check",
    value: isACPAutoAcceptEnabled(config),
  };
}

export class CursorPrintAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly label?: string;
  private readonly spawn: CursorPrintSpawn;
  private readonly execModels: (command: string, args: string[], cwd: string) => Promise<string>;

  constructor(options: CursorPrintAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.provider = options.providerId ?? CURSOR_PRINT_PROVIDER_ID;
    this.label = options.label;
    this.spawn = options.spawn ?? defaultSpawn;
    this.execModels =
      options.execModels ??
      (async (command, args, cwd) => {
        const result = await execCommand(command, args, {
          cwd,
          timeout: MODELS_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        });
        return result.stdout;
      });
  }

  private resolveCommand(): { command: string; args: string[] } {
    if (
      this.runtimeSettings?.command?.mode === "replace" &&
      this.runtimeSettings.command.argv.length > 0
    ) {
      const [command, ...args] = this.runtimeSettings.command.argv;
      return { command, args };
    }
    const [command, ...args] = CURSOR_PRINT_DEFAULT_COMMAND;
    return { command, args };
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return new CursorPrintAgentSession({
      config: withAbsoluteCwd({ ...config, provider: this.provider }),
      logger: this.logger,
      capabilities: this.capabilities,
      command: this.resolveCommand(),
      env: {
        ...this.runtimeSettings?.env,
        ...launchContext?.env,
      },
      spawn: this.spawn,
      resumeChatId: null,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const cwd = resolveAbsoluteWorkspace(overrides?.cwd ?? metadata.cwd ?? process.cwd());

    // Cross-project leakage guard (cc-connect SessionIDValidator): refuse to
    // resume a chat id that is not present under this workspace hash.
    let resumeChatId: string | null = handle.sessionId;
    if (resumeChatId) {
      const dir = await findCursorPrintSessionDir(cwd, resumeChatId);
      if (!dir) {
        this.logger.warn(
          { sessionId: resumeChatId, cwd },
          "cursor-print: session id not found for workspace; starting fresh",
        );
        resumeChatId = null;
      }
    }

    return new CursorPrintAgentSession({
      config: withAbsoluteCwd({
        cwd,
        ...metadata,
        ...overrides,
        provider: this.provider,
      }),
      logger: this.logger,
      capabilities: this.capabilities,
      command: this.resolveCommand(),
      env: {
        ...this.runtimeSettings?.env,
        ...launchContext?.env,
      },
      spawn: this.spawn,
      resumeChatId,
    });
  }

  async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const cwd = options.scope === "workspace" ? options.cwd : process.cwd();
    const { command, args } = this.resolveCommand();
    const modes = getAgentProviderDefinition(CURSOR_PRINT_PROVIDER_ID).modes.map(
      ({ icon: _icon, colorTier: _colorTier, ...mode }) => mode,
    );
    try {
      const stdout = await this.execModels(command, [...args, "models"], cwd);
      return {
        models: parseModelsOutput(stdout, this.provider),
        modes,
        defaultModeId: CURSOR_PRINT_DEFAULT_MODE_ID,
      };
    } catch (error) {
      this.logger.warn({ err: error }, "cursor-print: agent models failed");
      return {
        models: [],
        modes,
        defaultModeId: CURSOR_PRINT_DEFAULT_MODE_ID,
      };
    }
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [buildCursorPrintAutoAcceptFeature(config)];
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return listCursorPrintImportableSessions({
      cwd: options?.cwd,
      limit: options?.limit,
    });
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context: {
        ...context,
        config: withAbsoluteCwd(context.config),
        storedConfig: withAbsoluteCwd(context.storedConfig),
      },
      resumeSession: this.resumeSession.bind(this),
    });
  }

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    const cwd = resolveAbsoluteWorkspace(
      (typeof handle.metadata?.cwd === "string" && handle.metadata.cwd) || process.cwd(),
    );
    await deleteCursorPrintSession(cwd, handle.sessionId);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const providerName = this.label ?? this.provider;
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return {
        diagnostic: formatProviderDiagnostic(providerName, [
          { label: "Transport", value: "print/stream-json (non-ACP)" },
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [launch.command],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError(providerName, error),
      };
    }
  }

  private async resolveLaunch(): Promise<ResolvedProviderLaunch> {
    const { command } = this.resolveCommand();
    if (this.runtimeSettings?.command?.mode === "replace") {
      return resolveProviderLaunch({
        commandConfig: this.runtimeSettings.command,
      });
    }
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: command,
    });
  }
}

interface CursorPrintAgentSessionOptions {
  config: AgentSessionConfig;
  logger: Logger;
  capabilities: AgentCapabilityFlags;
  command: { command: string; args: string[] };
  env?: Record<string, string>;
  spawn: CursorPrintSpawn;
  resumeChatId: string | null;
}

export class CursorPrintAgentSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;

  private readonly config: AgentSessionConfig;
  private readonly logger: Logger;
  private readonly command: { command: string; args: string[] };
  private readonly env?: Record<string, string>;
  private readonly spawn: CursorPrintSpawn;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  private chatId: string | null;
  private modeId: string;
  private modelId: string | null;
  private autoAcceptEnabled: boolean;
  private activeTurn: ActiveTurn | null = null;
  private closed = false;
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(options: CursorPrintAgentSessionOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.provider = options.config.provider;
    this.capabilities = options.capabilities;
    this.command = options.command;
    this.env = options.env;
    this.spawn = options.spawn;
    this.chatId = options.resumeChatId;
    this.modeId = normalizeModeId(options.config.modeId);
    this.modelId = options.config.model ?? null;
    this.autoAcceptEnabled = isACPAutoAcceptEnabled(options.config);
  }

  get id(): string | null {
    return this.chatId;
  }

  get features(): AgentFeature[] {
    return [buildCursorPrintAutoAcceptFeature(this.config)];
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.chatId ?? "",
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("cursor-print session is closed");
    }
    if (this.activeTurn) {
      throw new Error("A cursor-print turn is already active");
    }

    const turnId = randomUUID();
    const assistantMessageId = randomUUID();
    const userText = promptToText(prompt);
    const cliPrompt = buildCursorPrintCliPrompt(userText, this.config);
    this.launchTurnProcess({
      turnId,
      assistantMessageId,
      userText,
      cliPrompt,
      resumeChatId: this.chatId,
      allowResumeFallback: Boolean(this.chatId),
      emitTurnStarted: true,
      clientMessageId: options?.clientMessageId,
    });
    return { turnId };
  }

  private launchTurnProcess(options: {
    turnId: string;
    assistantMessageId: string;
    userText: string;
    cliPrompt: string;
    resumeChatId: string | null;
    allowResumeFallback: boolean;
    emitTurnStarted: boolean;
    clientMessageId?: string;
  }): void {
    const args = buildTurnArgs({
      extraArgs: this.command.args,
      modeId: this.modeId,
      model: this.modelId,
      resumeChatId: options.resumeChatId,
      workspace: this.config.cwd,
      prompt: options.cliPrompt,
    });

    this.logger.debug(
      {
        resume: Boolean(options.resumeChatId),
        resumeChatId: options.resumeChatId,
        modeId: this.modeId,
        model: this.modelId,
        cwd: this.config.cwd,
      },
      "cursor-print: launching turn",
    );

    const child = this.spawn({
      command: this.command.command,
      args,
      cwd: this.config.cwd,
      env: this.env,
    });

    this.activeTurn = {
      turnId: options.turnId,
      assistantMessageId: options.assistantMessageId,
      assistantAccumulated: "",
      child,
      thinkingText: "",
      pendingInteractions: new Map(),
      toolCallIds: new Map(),
      completed: false,
      resumedWith: options.resumeChatId,
      allowResumeFallback: options.allowResumeFallback,
      promptText: options.cliPrompt,
      userText: options.userText,
    };
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    if (options.emitTurnStarted) {
      this.emit({
        type: "turn_started",
        provider: this.provider,
        turnId: options.turnId,
      });
      this.emitSubmittedUserMessage(options.userText, options.turnId, options.clientMessageId);
    }
    if (this.chatId) {
      this.emit({
        type: "thread_started",
        sessionId: this.chatId,
        provider: this.provider,
      });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 16_384) {
        this.stderrBuffer = this.stderrBuffer.slice(-16_384);
      }
    });
    child.on("error", (error) => {
      this.failTurn(toDiagnosticErrorMessage(error));
    });
    child.on("exit", (code, signal) => {
      const turn = this.activeTurn;
      if (!turn || turn.child !== child || turn.completed) {
        return;
      }
      const stderr = this.stderrBuffer.trim();
      const detail =
        stderr ||
        `cursor-print process exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      this.failTurn(detail);
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.chatId) {
      return;
    }
    const history = await readCursorPrintHistory({
      cwd: this.config.cwd,
      sessionId: this.chatId,
    });
    for (const entry of history) {
      yield {
        type: "timeline",
        provider: this.provider,
        item:
          entry.role === "user"
            ? { type: "user_message", text: entry.text }
            : { type: "assistant_message", text: entry.text },
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.chatId,
      model: this.modelId,
      modeId: this.modeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return getAgentProviderDefinition(CURSOR_PRINT_PROVIDER_ID).modes.map(
      ({ icon: _icon, colorTier: _colorTier, ...mode }) => mode,
    );
  }

  async getCurrentMode(): Promise<string | null> {
    return this.modeId;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    this.modeId = normalizeModeId(modeId);
    this.emit({
      type: "mode_changed",
      provider: this.provider,
      currentModeId: this.modeId,
      availableModes: await this.getAvailableModes(),
    });
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    const pending = this.activeTurn?.pendingInteractions;
    if (!pending || pending.size === 0) {
      return [];
    }
    return Array.from(pending.values(), (entry) => entry.request);
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const turn = this.activeTurn;
    const pending = turn?.pendingInteractions.get(requestId);
    if (!turn || !pending) {
      return;
    }
    turn.pendingInteractions.delete(requestId);
    const approved = response.behavior === "allow";
    const reason = response.behavior === "deny" ? (response.message ?? "User denied") : "";
    this.writeInteractionResponse(pending.queryId, pending.queryType, approved, reason);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: turn.turnId,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.chatId) {
      return null;
    }
    return {
      provider: this.provider,
      sessionId: this.chatId,
      metadata: {
        cwd: this.config.cwd,
        model: this.modelId,
        modeId: this.modeId,
      },
    };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn?.child) {
      return;
    }
    this.clearPendingInteractions(turn, "Interrupted");
    const child = turn.child;
    turn.child = null;
    await terminateWithTreeKill(child, {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 2_000,
    });
    this.activeTurn = null;
    this.emit({
      type: "turn_canceled",
      provider: this.provider,
      reason: "Interrupted",
      turnId: turn.turnId,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
    this.subscribers.clear();
  }

  async setModel(modelId: string | null): Promise<void> {
    this.modelId = modelId;
    this.emit({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: await this.getRuntimeInfo(),
    });
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId !== ACP_AUTO_ACCEPT_FEATURE_ID) {
      throw new Error(`Unknown ${this.provider} feature: ${featureId}`);
    }
    const enabled = parseACPAutoAcceptFeatureValue(value) === true;
    this.autoAcceptEnabled = enabled;
    this.config.featureValues = {
      ...this.config.featureValues,
      [ACP_AUTO_ACCEPT_FEATURE_ID]: enabled,
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private emitTimeline(turnId: string, item: AgentTimelineItem): void {
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item,
    });
  }

  private emitSubmittedUserMessage(
    promptText: string,
    turnId: string,
    clientMessageId?: string,
  ): void {
    if (promptText.trim().length === 0) {
      return;
    }
    this.emitTimeline(turnId, {
      type: "user_message",
      text: promptText,
      messageId: randomUUID(),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  }

  private clearPendingInteractions(turn: ActiveTurn, message: string): void {
    for (const [requestId, pending] of turn.pendingInteractions) {
      this.writeInteractionResponse(pending.queryId, pending.queryType, false, message);
      this.emit({
        type: "permission_resolved",
        provider: this.provider,
        requestId,
        resolution: { behavior: "deny", message },
        turnId: turn.turnId,
      });
    }
    turn.pendingInteractions.clear();
  }

  private buildInteractionPermissionDetail(
    toolName: string,
    args: Record<string, unknown>,
  ): AgentPermissionRequest["detail"] {
    if (toolName === "Bash") {
      return { type: "shell", command: readString(args.command) ?? "" };
    }
    if (toolName === "WebFetch") {
      return {
        type: "fetch",
        url: readString(args.url) ?? "",
      };
    }
    return { type: "unknown", input: args, output: undefined };
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleEventLine(line);
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleEventLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.logger.debug({ line }, "cursor-print: non-JSON stdout line");
      return;
    }
    if (!isRecord(raw)) {
      return;
    }
    const type = readString(raw.type);
    switch (type) {
      case "system":
        this.handleSystem(raw);
        break;
      case "thinking":
        this.handleThinking(raw);
        break;
      case "assistant":
        this.handleAssistant(raw);
        break;
      case "tool_call":
        this.handleToolCall(raw);
        break;
      case "interaction_query":
        this.handleInteractionQuery(raw);
        break;
      case "result":
        this.handleResult(raw);
        break;
      default:
        break;
    }
  }

  private handleSystem(raw: Record<string, unknown>): void {
    const sessionId = readString(raw.session_id);
    if (sessionId) {
      const previous = this.chatId;
      this.chatId = sessionId;
      // Persist immediately so daemon can write persistence.sessionId before
      // the turn completes (cc-connect SessionIDWriteback_ImmediateAfterStart).
      if (previous !== sessionId) {
        this.emit({
          type: "thread_started",
          sessionId,
          provider: this.provider,
        });
        void this.getRuntimeInfo().then((runtimeInfo) => {
          this.emit({
            type: "model_changed",
            provider: this.provider,
            runtimeInfo,
          });
          return undefined;
        });
      }
    }
    const model = readString(raw.model);
    if (model) {
      this.modelId = model;
    }
  }

  private handleThinking(raw: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const subtype = readString(raw.subtype);
    if (subtype === "delta") {
      const text = readString(raw.text);
      if (text) {
        turn.thinkingText += text;
        // Emit pure deltas — timeline projection concatenates adjacent reasoning chunks.
        this.emitTimeline(turn.turnId, {
          type: "reasoning",
          text,
        });
      }
      return;
    }
    // completed — deltas already streamed; just clear the buffer.
    turn.thinkingText = "";
  }

  private handleAssistant(raw: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const message = isRecord(raw.message) ? raw.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    const hasModelCallId = Boolean(readString(raw.model_call_id));
    for (const item of content) {
      if (!isRecord(item) || item.type !== "text") {
        continue;
      }
      const incoming = readString(item.text);
      if (!incoming) {
        continue;
      }
      const resolved = resolveAssistantEmitText({
        incoming,
        accumulated: turn.assistantAccumulated,
        hasModelCallId,
      });
      turn.assistantAccumulated = resolved.nextAccumulated;
      if (resolved.skip) {
        continue;
      }
      this.emitTimeline(turn.turnId, {
        type: "assistant_message",
        text: resolved.text,
        messageId: turn.assistantMessageId,
      });
    }
  }

  private handleToolCall(raw: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const subtype = readString(raw.subtype);
    const toolCall = isRecord(raw.tool_call) ? raw.tool_call : null;
    if (!toolCall) {
      return;
    }
    const eventCallId = readString(raw.call_id);
    const mapped = mapCursorPrintToolCall(toolCall, eventCallId);
    if (!mapped) {
      return;
    }

    // New tool segment → next assistant reply gets a fresh message id (ACP does this too).
    turn.assistantMessageId = randomUUID();
    turn.assistantAccumulated = "";
    turn.thinkingText = "";

    const lookupKey = mapped.callId ?? mapped.callKey;
    if (subtype === "started") {
      const callId = mapped.callId ?? `${turn.turnId}:${mapped.callKey}:${randomUUID()}`;
      turn.toolCallIds.set(lookupKey, callId);
      this.emitTimeline(turn.turnId, toToolCallTimelineItem({ callId, mapped, status: "running" }));
      return;
    }
    if (subtype === "completed") {
      const callId =
        turn.toolCallIds.get(lookupKey) ?? mapped.callId ?? `${turn.turnId}:${mapped.callKey}:done`;
      const status = mapped.failed ? "failed" : "completed";
      this.emitTimeline(turn.turnId, toToolCallTimelineItem({ callId, mapped, status }));
    }
  }

  private handleInteractionQuery(raw: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn || readString(raw.subtype) !== "request") {
      return;
    }
    const queryType = readString(raw.query_type);
    const query = isRecord(raw.query) ? raw.query : null;
    if (!queryType || !query) {
      return;
    }
    const queryId = typeof query.id === "number" ? query.id : Number(query.id);
    if (!Number.isFinite(queryId)) {
      return;
    }

    const inner = isRecord(query[queryType]) ? query[queryType] : null;
    if (inner?.skipApproval === true || this.modeId === "force" || this.modeId === "auto-review") {
      this.writeInteractionResponse(queryId, queryType, true, "");
      return;
    }

    // Match ACP: plan/ask disable auto_accept but still surface permission UI.
    if (this.autoAcceptEnabled && !isPlanLikePrintMode(this.modeId)) {
      this.writeInteractionResponse(queryId, queryType, true, "");
      return;
    }

    let toolName = queryType;
    if (queryType === "shellRequestQuery") {
      toolName = "Bash";
    } else if (queryType === "webFetchRequestQuery") {
      toolName = "WebFetch";
    }
    const args = isRecord(inner?.args) ? inner.args : {};
    const requestId = `${queryType}:${queryId}`;
    const existing = turn.pendingInteractions.get(requestId);
    if (existing) {
      // Same query id re-sent — deny the stale slot before replacing.
      this.writeInteractionResponse(
        existing.queryId,
        existing.queryType,
        false,
        "superseded by a newer permission request",
      );
      this.emit({
        type: "permission_resolved",
        provider: this.provider,
        requestId,
        resolution: {
          behavior: "deny",
          message: "superseded by a newer permission request",
        },
        turnId: turn.turnId,
      });
      turn.pendingInteractions.delete(requestId);
    }

    const request: AgentPermissionRequest = {
      id: requestId,
      provider: this.provider,
      name: toolName,
      kind: "tool",
      title: toolName,
      input: args,
      detail: this.buildInteractionPermissionDetail(toolName, args),
    };
    turn.pendingInteractions.set(requestId, {
      requestId,
      queryId,
      queryType,
      request,
    });
    this.emit({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: turn.turnId,
    });
  }

  private handleResult(raw: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const sessionId = readString(raw.session_id);
    if (sessionId) {
      this.chatId = sessionId;
    }
    // Thinking deltas already streamed; do not re-emit the accumulated buffer.
    turn.thinkingText = "";

    const usage = mapUsage(raw.usage);
    if (usage) {
      this.emit({
        type: "usage_updated",
        provider: this.provider,
        usage,
        turnId: turn.turnId,
      });
    }

    const isError = raw.is_error === true || readString(raw.subtype) === "error";
    const child = turn.child;
    this.clearPendingInteractions(turn, isError ? "Turn failed" : "Turn completed");
    turn.completed = true;
    turn.child = null;
    this.activeTurn = null;
    if (child && !child.killed) {
      child.stdin?.end();
    }

    if (isError) {
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        turnId: turn.turnId,
        error: readString(raw.result) ?? "cursor-print turn failed",
      });
      return;
    }

    this.emit({
      type: "turn_completed",
      provider: this.provider,
      turnId: turn.turnId,
      usage,
    });
  }

  private failTurn(error: string): void {
    const turn = this.activeTurn;
    if (!turn || turn.completed) {
      return;
    }

    // cc-connect engine pattern: resume/continue failure → clear id and retry fresh.
    if (turn.allowResumeFallback && turn.resumedWith && isCursorResumeFailure(error)) {
      this.logger.warn(
        { sessionId: turn.resumedWith, error },
        "cursor-print: resume failed; retrying as fresh session",
      );
      this.clearPendingInteractions(turn, "Resume failed; retrying");
      const child = turn.child;
      turn.child = null;
      if (child) {
        void terminateWithTreeKill(child, {
          gracefulTimeoutMs: 2_000,
          forceTimeoutMs: 2_000,
        });
      }
      this.chatId = null;
      this.launchTurnProcess({
        turnId: turn.turnId,
        assistantMessageId: turn.assistantMessageId,
        userText: turn.userText,
        cliPrompt: turn.promptText,
        resumeChatId: null,
        allowResumeFallback: false,
        emitTurnStarted: false,
      });
      return;
    }

    this.clearPendingInteractions(turn, error);
    const child = turn.child;
    turn.completed = true;
    turn.child = null;
    this.activeTurn = null;
    if (child) {
      void terminateWithTreeKill(child, {
        gracefulTimeoutMs: 2_000,
        forceTimeoutMs: 2_000,
      });
    }
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      turnId: turn.turnId,
      error,
    });
  }

  private writeInteractionResponse(
    queryId: number,
    queryType: string,
    approved: boolean,
    reason: string,
  ): void {
    const child = this.activeTurn?.child;
    if (!child?.stdin) {
      this.logger.warn("cursor-print: stdin unavailable for interaction response");
      return;
    }
    const responseKey = `${queryType.replace(/Query$/, "")}Response`;
    const resultValue = approved ? { approved: {} } : { rejected: { reason: reason || "denied" } };
    const payload = {
      type: "interaction_query",
      subtype: "response",
      query_type: queryType,
      response: {
        id: queryId,
        [responseKey]: resultValue,
      },
    };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
