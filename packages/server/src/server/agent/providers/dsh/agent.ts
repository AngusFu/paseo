import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentStreamEvent,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ImportedProviderSession,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
} from "../../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { importSessionFromPersistence } from "../../provider-session-import.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";
import { toDiagnosticErrorMessage } from "../diagnostic-utils.js";
import { materializeDshCordis } from "./dsh-cordis.js";
import { createDshSessionId, formatDshSessionId, type DshLocationOptions } from "./dsh-home.js";
import { ensureDshProfile, readDshProfileState } from "./dsh-profile.js";
import { ensureDshProfilePlugins, resolveDshNodeModulesSearchPaths } from "./dsh-plugins.js";
import { attachDshSessionToWorkspace } from "./dsh-workspace.js";
import { listDshImportableSessions, readDshImportSessionConfig } from "./dsh-session-import.js";
import { isInboxReceipt, mapDshNotification } from "./event-mapper.js";
import type { JsonRpcNotification } from "./jsonrpc-transport.js";
import {
  buildDshCatalogModels,
  DSH_DEFAULT_MODEL_ID,
  DSH_PROVIDER_ID,
  resolveDshModelId,
  resolveDshModelRoute,
} from "./models.js";
import {
  checkDshRuntimeAvailable,
  DshCliRuntime,
  type DshContentBlock,
  type DshRuntime,
  type DshRuntimeSession,
  resolveDshCordis,
  resolveDshRuntimeBin,
} from "./runtime.js";

const DSH_BASE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

function capabilitiesForClient(): AgentCapabilityFlags {
  return { ...DSH_BASE_CAPABILITIES };
}

function capabilitiesForSession(hasMcpServers: boolean): AgentCapabilityFlags {
  return {
    ...DSH_BASE_CAPABILITIES,
    supportsMcpServers: hasMcpServers,
  };
}

export const DshProviderParamsSchema = z
  .object({
    runtimeBin: z.string().min(1).optional(),
    cordis: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    nodeModulesRoots: z.array(z.string().min(1)).optional(),
    profileHome: z.string().min(1).optional(),
    sessionRoot: z.string().min(1).optional(),
  })
  .strict();

type DshProviderParams = z.infer<typeof DshProviderParamsSchema>;

export interface DshAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  runtime?: DshRuntime;
}

interface ActiveTurnState {
  turnId: string;
  messageId: string | null;
  receivedInbox: boolean;
  clientMessageId: string | null;
  bufferedNotifications: JsonRpcNotification[];
}

export class DshAgentSession implements AgentSession {
  readonly provider: AgentProvider = DSH_PROVIDER_ID;
  readonly capabilities: AgentCapabilityFlags;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly cordisCleanup?: () => void;
  private activeTurn: ActiveTurnState | null = null;
  private activeAssistantMessageId: string | null = null;
  private readonly toolCalls = new Map<string, { name: string; args: unknown }>();
  private closed = false;
  private modelId: string;

  constructor(
    private readonly runtimeSession: DshRuntimeSession,
    private readonly config: AgentSessionConfig,
    private readonly sessionId: string,
    private readonly sessionRoot: string,
    capabilities: AgentCapabilityFlags,
    cordisCleanup?: () => void,
  ) {
    this.capabilities = capabilities;
    this.cordisCleanup = cordisCleanup;
    this.modelId = resolveDshModelId(config.model);
    this.unsubscribeNotification = runtimeSession.onNotification((notification) => {
      this.handleNotification(notification);
    });
    this.unsubscribeExit = runtimeSession.onExit((error) => {
      this.handleProcessExit(error);
    });
  }

  get id(): string | null {
    return this.sessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionId,
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("DeepSeek Harness session is closed");
    }
    if (this.activeTurn) {
      throw new Error("A DeepSeek Harness turn is already active");
    }

    const turnId = randomUUID();
    this.activeTurn = {
      turnId,
      messageId: null,
      receivedInbox: false,
      clientMessageId: options?.clientMessageId ?? null,
      bufferedNotifications: [],
    };
    this.activeAssistantMessageId = null;
    this.toolCalls.clear();

    this.emit({
      type: "turn_started",
      provider: this.provider,
      turnId,
    });

    void this.runTurn(prompt, turnId);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // MVP: SDK history hydration is not wired yet.
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.modelId,
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {
    throw new Error("DeepSeek Harness does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    throw new Error("DeepSeek Harness has no pending permissions");
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        cwd: this.config.cwd,
        model: this.modelId,
        sessionRoot: this.sessionRoot,
      },
    };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    await this.runtimeSession.kill();
    if (turn && this.activeTurn?.turnId === turn.turnId) {
      this.activeTurn = null;
      this.activeAssistantMessageId = null;
      this.emit({
        type: "turn_canceled",
        provider: this.provider,
        turnId: turn.turnId,
        reason: "interrupted",
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeNotification();
    this.unsubscribeExit();
    await this.runtimeSession.close();
    this.cordisCleanup?.();
  }

  async setModel(modelId: string | null): Promise<void> {
    this.modelId = resolveDshModelId(modelId);
  }

  private async runTurn(prompt: AgentPromptInput, turnId: string): Promise<void> {
    try {
      const contentBlocks = convertPromptToContentBlocks(prompt);
      const messageId = await this.runtimeSession.prompt(this.sessionId, contentBlocks);
      if (this.activeTurn?.turnId !== turnId) {
        return;
      }
      this.activeTurn.messageId = messageId;
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "user_message",
          text: contentBlocksToText(contentBlocks),
          messageId,
          ...(this.activeTurn.clientMessageId
            ? { clientMessageId: this.activeTurn.clientMessageId }
            : {}),
        },
      });
      const buffered = this.activeTurn.bufferedNotifications;
      this.activeTurn.bufferedNotifications = [];
      for (const notification of buffered) {
        this.processNotification(notification);
      }
    } catch (error) {
      if (this.activeTurn?.turnId !== turnId) {
        return;
      }
      this.activeTurn = null;
      this.activeAssistantMessageId = null;
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: toDiagnosticErrorMessage(error),
      });
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (!turn.messageId) {
      turn.bufferedNotifications.push(notification);
      return;
    }
    this.processNotification(notification);
  }

  private processNotification(notification: JsonRpcNotification): void {
    const turn = this.activeTurn;
    if (!turn?.messageId) {
      return;
    }

    if (!turn.receivedInbox) {
      if (isInboxReceipt(notification, this.sessionId, turn.messageId)) {
        turn.receivedInbox = true;
      } else {
        return;
      }
    }

    const mapped = mapDshNotification(notification, {
      provider: this.provider,
      sessionId: this.sessionId,
      turnId: turn.turnId,
      activeAssistantMessageId: this.activeAssistantMessageId,
      toolCalls: this.toolCalls,
    });
    this.activeAssistantMessageId = mapped.activeAssistantMessageId;

    for (const event of mapped.events) {
      if (event.type === "timeline" && event.item.type === "user_message") {
        // Canonical user_message was already emitted from the prompt receipt.
        continue;
      }
      this.emit(event);
    }

    if (mapped.turnIdle && turn.receivedInbox) {
      this.activeTurn = null;
      this.activeAssistantMessageId = null;
      this.emit({
        type: "turn_completed",
        provider: this.provider,
        turnId: turn.turnId,
      });
    }
  }

  private handleProcessExit(error: Error): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.activeTurn = null;
    this.activeAssistantMessageId = null;
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      turnId: turn.turnId,
      error: error.message,
    });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

export class DshAgentClient implements AgentClient {
  readonly provider: AgentProvider = DSH_PROVIDER_ID;
  readonly capabilities: AgentCapabilityFlags;

  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly providerParams: DshProviderParams;
  private readonly runtime: DshRuntime;
  private readonly dshLocation: DshLocationOptions;

  constructor(options: DshAgentClientOptions) {
    this.capabilities = capabilitiesForClient();
    this.runtimeSettings = options.runtimeSettings;
    this.providerParams = DshProviderParamsSchema.parse(options.providerParams ?? {});
    this.dshLocation = {
      ...(this.providerParams.profileHome ? { profileHome: this.providerParams.profileHome } : {}),
      ...(this.providerParams.sessionRoot ? { sessionRoot: this.providerParams.sessionRoot } : {}),
    };
    this.runtime =
      options.runtime ??
      new DshCliRuntime({
        logger: options.logger,
        runtimeSettings: options.runtimeSettings,
      });
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const sessionId = createDshSessionId();
    return this.openSession(config, sessionId, launchContext);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const config: AgentSessionConfig = {
      provider: DSH_PROVIDER_ID,
      cwd: typeof handle.metadata?.cwd === "string" ? handle.metadata.cwd : process.cwd(),
      model:
        typeof handle.metadata?.model === "string" ? handle.metadata.model : DSH_DEFAULT_MODEL_ID,
      ...overrides,
    };
    return this.openSession(config, formatDshSessionId(handle.sessionId), launchContext);
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return listDshImportableSessions({
      ...options,
      ...this.dshLocation,
    });
  }

  async importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession> {
    const importConfig = await readDshImportSessionConfig(input.providerHandleId, this.dshLocation);
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
      config: importConfig.model ? { model: importConfig.model } : {},
      persistence: {
        provider: this.provider,
        sessionId: formatDshSessionId(input.providerHandleId),
        nativeHandle: formatDshSessionId(input.providerHandleId),
        metadata: {
          ...context.storedConfig,
          provider: this.provider,
          cwd: input.cwd,
          ...(importConfig.model ? { model: importConfig.model } : {}),
        },
      },
    });
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const profile = readDshProfileState(this.dshLocation);
    return {
      models: buildDshCatalogModels({ settings: profile.settings }),
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return checkDshRuntimeAvailable({
      runtimeSettings: this.runtimeSettings,
      runtimeBin: this.providerParams.runtimeBin,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const command = resolveDshRuntimeBin({
      runtimeSettings: this.runtimeSettings,
      runtimeBin: this.providerParams.runtimeBin,
    });
    const launch = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: { command },
    });
    const availability = await checkProviderLaunchAvailable(launch, { command });
    return {
      diagnostic: [
        "DeepSeek Harness",
        `  Binary: ${launch.command}`,
        `  Available: ${availability.available ? "yes" : "no"}`,
        `  Resolved: ${availability.resolvedPath ?? "not found"}`,
        `  Base cordis: ${this.resolveBaseCordisPath(launch.command)}`,
        `  Profile: ${readDshProfileState(this.dshLocation).profilePath}`,
        `  Sessions: ${readDshProfileState(this.dshLocation).sessionRoot}`,
      ].join("\n"),
    };
  }

  private resolveBaseCordisPath(runtimeBin: string): string {
    if (this.providerParams.cordis) {
      return this.providerParams.cordis;
    }
    return (
      resolveDshCordis({
        cordis: undefined,
        runtimeBin,
        env: {},
      }) ?? "(bundled/default)"
    );
  }

  private async openSession(
    config: AgentSessionConfig,
    sessionId: string,
    launchContext?: AgentLaunchContext,
  ): Promise<DshAgentSession> {
    const profile = ensureDshProfile(this.dshLocation);
    await ensureDshProfilePlugins(this.dshLocation);
    const sessionRoot = profile.sessionRoot;
    const normalizedSessionId = formatDshSessionId(sessionId);
    const modelRoute = resolveDshModelRoute(config.model);
    const hasMcpServers = Boolean(config.mcpServers && Object.keys(config.mcpServers).length > 0);

    const runtimeBin = resolveDshRuntimeBin({
      runtimeSettings: this.runtimeSettings,
      runtimeBin: this.providerParams.runtimeBin,
    });
    const baseCordisPath = this.resolveBaseCordisPath(runtimeBin);
    if (baseCordisPath === "(bundled/default)") {
      throw new Error("DSH base Cordis path could not be resolved");
    }

    const cordisMaterialized = materializeDshCordis({
      baseCordisPath,
      profile,
      sessionMcpServers: config.mcpServers,
    });

    const nodeModulesPaths = [
      ...resolveDshNodeModulesSearchPaths(this.dshLocation),
      ...(this.providerParams.nodeModulesRoots ?? []),
    ].filter((entry) => entry.trim().length > 0);

    let runtimeSession: DshRuntimeSession;
    try {
      runtimeSession = await this.runtime.startSession({
        cwd: config.cwd,
        env: launchContext?.env,
        dshHome: profile.profilePath,
        runtimeBin: this.providerParams.runtimeBin,
        cordis: cordisMaterialized.path,
        sessionRoot,
        nodeModulesPaths,
      });
    } catch (error) {
      cordisMaterialized.cleanup();
      throw error;
    }

    try {
      await runtimeSession.initialize({
        cwd: config.cwd,
        provider: modelRoute.provider,
        model: modelRoute.model,
        ...(this.providerParams.maxTokens !== undefined
          ? { maxTokens: this.providerParams.maxTokens }
          : {}),
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      cordisMaterialized.cleanup();
      throw error;
    }

    try {
      attachDshSessionToWorkspace({
        cwd: config.cwd,
        sessionId: normalizedSessionId,
        options: this.dshLocation,
      });
    } catch {
      // Best-effort workspace attachment into ~/.dsh/storages/workspace.json
    }

    return new DshAgentSession(
      runtimeSession,
      { ...config, model: modelRoute.catalogId },
      normalizedSessionId,
      sessionRoot,
      capabilitiesForSession(hasMcpServers),
      cordisMaterialized.cleanup,
    );
  }
}

function convertPromptToContentBlocks(prompt: AgentPromptInput): DshContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  const blocks: DshContentBlock[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      blocks.push({
        type: "text",
        text: `[Image attachment omitted: DeepSeek Harness MVP is text-only (${block.mimeType})]`,
      });
      continue;
    }
    blocks.push({ type: "text", text: renderPromptAttachmentAsText(block) });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function contentBlocksToText(blocks: DshContentBlock[]): string {
  return blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}
