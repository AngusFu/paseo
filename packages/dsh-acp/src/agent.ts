import { randomUUID } from "node:crypto";
import type {
  Agent,
  AuthenticateRequest,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModelRequest,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import type { DshAcpConfig } from "./config.js";
import {
  type DshModelCatalog,
  type DshModelDefinition,
  readDshModelCatalog,
  resolveDshModelRoute,
} from "./models.js";
import type {
  DshApprovalRequest,
  DshNotification,
  DshRuntime,
  DshRuntimeModel,
  DshRuntimeSession,
  DshRuntimeStart,
} from "./runtime.js";
import { LiveDshWorkspaceRegistry, type DshWorkspaceRegistry } from "./workspace.js";

export interface SessionUpdateSink {
  sessionUpdate(notification: SessionNotification): Promise<void>;
  requestPermission(params: {
    sessionId: string;
    toolCall: {
      toolCallId: string;
      title: string;
      kind: "execute" | "read" | "edit" | "search" | "other";
      status: "pending";
    };
    options: Array<{
      optionId: string;
      name: string;
      kind: "allow_once" | "reject_once";
    }>;
  }): Promise<{
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
  }>;
}

export interface DshAcpAgentOptions {
  connection: SessionUpdateSink;
  config: DshAcpConfig;
  runtime: DshRuntime;
  workspaceRegistry?: DshWorkspaceRegistry;
}

interface ActivePrompt {
  resolve(response: PromptResponse): void;
  reject(error: Error): void;
  dshMessageId: string | null;
  receivedInbox: boolean;
  receivedIdle: boolean;
  bufferedNotifications: DshNotification[];
  assistantMessageId: string;
  userMessageId?: string;
}

interface DshAcpSession {
  sessionId: string;
  cwd: string;
  runtimeSession: DshRuntimeSession;
  modelId: string;
  reasoningEffort: string | null;
  permissionMode: DshPermissionMode;
  mcpServers: McpServer[];
  unsubscribeNotification: () => void;
  unsubscribeApproval: () => void;
  unsubscribeExit: () => void;
  activePrompt: ActivePrompt | null;
  toolCalls: Map<string, { name: string; args: unknown }>;
  notificationQueue: Promise<void>;
  workspaceAttached: boolean;
  closed: boolean;
}

type DshPermissionMode = "ask" | "read-only" | "full-access";

export class DshAcpAgent implements Agent {
  private readonly sessions = new Map<string, DshAcpSession>();
  private readonly workspaceRegistry: DshWorkspaceRegistry;
  private catalog: DshModelCatalog;
  private closing = false;

  constructor(private readonly options: DshAcpAgentOptions) {
    this.catalog = readDshModelCatalog(options.config.dshHome);
    this.workspaceRegistry =
      options.workspaceRegistry ?? new LiveDshWorkspaceRegistry(options.config.dshHome);
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "dsh-acp",
        version: "0.1.106",
      },
      agentCapabilities: {
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {
          resume: {},
        },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.closing) {
      throw new Error("dsh-acp is closing");
    }
    const sessionId = `session-${randomUUID()}`;
    const configuredModelId = this.resolveConfiguredModelId();
    const model = this.requireModel(configuredModelId);
    const reasoningEffort = this.resolveInitialReasoningEffort(model);
    await this.workspaceRegistry.ensure(params.cwd);
    const session = await this.openSession({
      sessionId,
      cwd: params.cwd,
      modelId: configuredModelId,
      reasoningEffort,
      permissionMode: "ask",
      mcpServers: params.mcpServers,
    });
    await this.refreshRuntimeCatalog(session.runtimeSession);
    this.sessions.set(sessionId, session);
    return {
      sessionId,
      models: this.modelState(configuredModelId),
      modes: permissionModeState("ask"),
      configOptions: this.configOptions(session),
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (this.closing) {
      throw new Error("dsh-acp is closing");
    }
    if (this.sessions.has(params.sessionId)) {
      throw new Error(`DSH session is already open: ${params.sessionId}`);
    }
    const configuredModelId = this.resolveConfiguredModelId();
    const model = this.requireModel(configuredModelId);
    const reasoningEffort = this.resolveInitialReasoningEffort(model);
    await this.workspaceRegistry.ensure(params.cwd);
    await this.workspaceRegistry.attach({ cwd: params.cwd, sessionId: params.sessionId });
    const session = await this.openSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      modelId: configuredModelId,
      reasoningEffort,
      permissionMode: "ask",
      mcpServers: params.mcpServers ?? [],
      resume: true,
    });
    await this.refreshRuntimeCatalog(session.runtimeSession);
    this.sessions.set(params.sessionId, session);
    return {
      models: this.modelState(configuredModelId),
      modes: permissionModeState("ask"),
      configOptions: this.configOptions(session),
    };
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<void> {
    const session = this.requireSession(params.sessionId);
    this.assertIdle(session);
    const model = this.requireModel(params.modelId);
    session.modelId = params.modelId;
    session.reasoningEffort = this.resolveInitialReasoningEffort(model);
    await this.restartRuntime(session);
    await this.options.connection.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: this.configOptions(session),
      },
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<void> {
    const session = this.requireSession(params.sessionId);
    this.assertIdle(session);
    if (!isPermissionMode(params.modeId)) {
      throw new Error(`Unknown DSH permission mode: ${params.modeId}`);
    }
    session.permissionMode = params.modeId;
    await this.restartRuntime(session);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    this.assertIdle(session);
    if (params.configId !== "dsh-thinking" || typeof params.value !== "string") {
      throw new Error(`Unknown DSH config option: ${params.configId}`);
    }
    const model = this.requireModel(session.modelId);
    const efforts = model.reasoningEfforts ?? [];
    if (!efforts.includes(params.value)) {
      throw new Error(`Model ${session.modelId} does not support reasoning effort ${params.value}`);
    }
    session.reasoningEffort = params.value;
    await this.restartRuntime(session);
    return { configOptions: this.configOptions(session) };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.activePrompt) {
      throw new Error(`A prompt is already active for session ${params.sessionId}`);
    }
    const text = promptToText(params.prompt);
    if (!text.trim()) {
      throw new Error("Prompt must contain text or resource links");
    }

    const userMessageId = params.messageId ?? undefined;
    const deferred = createPromptDeferred(userMessageId);
    const response = deferred.promise;
    session.activePrompt = deferred.active;

    try {
      const dshMessageId = await session.runtimeSession.prompt(session.sessionId, text);
      if (!session.activePrompt) {
        return { stopReason: "cancelled", ...(userMessageId ? { userMessageId } : {}) };
      }
      const active: ActivePrompt = session.activePrompt;
      active.dshMessageId = dshMessageId;
      const buffered = active.bufferedNotifications;
      active.bufferedNotifications = [];
      for (const notification of buffered) {
        await this.processNotification(session, notification);
      }
    } catch (error) {
      this.failActivePrompt(session, toError(error));
    }

    return response;
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session?.activePrompt) {
      return;
    }
    const active = session.activePrompt;
    session.activePrompt = null;
    active.resolve({
      stopReason: "cancelled",
      ...(active.userMessageId ? { userMessageId: active.userMessageId } : {}),
    });
    await this.replaceKilledRuntime(session);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.closeSession(session)));
  }

  private async openSession(input: {
    sessionId: string;
    cwd: string;
    modelId: string;
    reasoningEffort: string | null;
    permissionMode: DshPermissionMode;
    mcpServers: McpServer[];
    resume?: boolean;
  }): Promise<DshAcpSession> {
    const runtimeSession = await this.options.runtime.start(this.buildRuntimeStart(input));
    if (input.resume) {
      try {
        await runtimeSession.resume(input.sessionId);
      } catch (error) {
        await runtimeSession.close();
        throw error;
      }
    }
    const session: DshAcpSession = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      runtimeSession,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode,
      mcpServers: input.mcpServers,
      unsubscribeNotification: () => undefined,
      unsubscribeApproval: () => undefined,
      unsubscribeExit: () => undefined,
      activePrompt: null,
      toolCalls: new Map(),
      notificationQueue: Promise.resolve(),
      workspaceAttached: Boolean(input.resume),
      closed: false,
    };
    this.bindRuntime(session);
    return session;
  }

  private bindRuntime(session: DshAcpSession): void {
    session.unsubscribeNotification = session.runtimeSession.onNotification((notification) => {
      session.notificationQueue = session.notificationQueue
        .then(() => this.handleNotification(session, notification))
        .catch((error: unknown) => {
          this.failActivePrompt(session, toError(error));
        });
    });
    session.unsubscribeApproval = session.runtimeSession.onApprovalRequest((request) => {
      void this.handleApprovalRequest(session, request);
    });
    session.unsubscribeExit = session.runtimeSession.onExit((error) => {
      this.failActivePrompt(session, error);
    });
  }

  private async handleNotification(
    session: DshAcpSession,
    notification: DshNotification,
  ): Promise<void> {
    const active = session.activePrompt;
    if (!active) {
      return;
    }
    if (!active.dshMessageId) {
      active.bufferedNotifications.push(notification);
      return;
    }
    await this.processNotification(session, notification);
  }

  private async processNotification(
    session: DshAcpSession,
    notification: DshNotification,
  ): Promise<void> {
    const active = session.activePrompt;
    if (!active?.dshMessageId) {
      return;
    }

    if (isSessionIdle(notification, session.sessionId)) {
      if (!session.workspaceAttached) {
        await this.workspaceRegistry.attach({ cwd: session.cwd, sessionId: session.sessionId });
        session.workspaceAttached = true;
      }
      active.receivedIdle = true;
      this.completeIfReady(session);
      return;
    }

    if (!active.receivedInbox) {
      if (!isInboxReceipt(notification, session.sessionId, active.dshMessageId)) {
        return;
      }
      active.receivedInbox = true;
      this.completeIfReady(session);
      return;
    }

    const update = mapNotification(notification, session, active.assistantMessageId);
    if (update) {
      await this.options.connection.sessionUpdate({ sessionId: session.sessionId, update });
    }
  }

  private completeIfReady(session: DshAcpSession): void {
    const active = session.activePrompt;
    if (!active?.receivedInbox || !active.receivedIdle) {
      return;
    }
    session.activePrompt = null;
    active.resolve({
      stopReason: "end_turn",
      ...(active.userMessageId ? { userMessageId: active.userMessageId } : {}),
    });
  }

  private failActivePrompt(session: DshAcpSession, error: Error): void {
    const active = session.activePrompt;
    if (!active) {
      return;
    }
    session.activePrompt = null;
    active.reject(error);
  }

  private async replaceKilledRuntime(session: DshAcpSession): Promise<void> {
    session.unsubscribeNotification();
    session.unsubscribeApproval();
    session.unsubscribeExit();
    await session.runtimeSession.kill();
    if (session.closed || this.closing) {
      return;
    }
    session.runtimeSession = await this.options.runtime.start(this.buildRuntimeStart(session));
    session.toolCalls.clear();
    this.bindRuntime(session);
  }

  private async closeSession(session: DshAcpSession): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    session.unsubscribeNotification();
    session.unsubscribeApproval();
    session.unsubscribeExit();
    const active = session.activePrompt;
    session.activePrompt = null;
    if (active) {
      active.resolve({
        stopReason: "cancelled",
        ...(active.userMessageId ? { userMessageId: active.userMessageId } : {}),
      });
    }
    await session.runtimeSession.close();
  }

  private requireSession(sessionId: string): DshAcpSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      throw new Error(`Unknown DSH session: ${sessionId}`);
    }
    return session;
  }

  private buildRuntimeStart(input: {
    cwd: string;
    modelId: string;
    reasoningEffort: string | null;
    permissionMode: DshPermissionMode;
    mcpServers: McpServer[];
  }): DshRuntimeStart {
    const route = resolveDshModelRoute(input.modelId);
    return {
      cwd: input.cwd,
      provider: route.provider,
      model: route.model,
      permissionMode: input.permissionMode,
      mcpServers: input.mcpServers,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      dshHome: this.options.config.dshHome,
      sessionRoot: this.options.config.sessionRoot,
      ...(this.options.config.runtimeBin ? { runtimeBin: this.options.config.runtimeBin } : {}),
      ...(this.options.config.cordis ? { cordis: this.options.config.cordis } : {}),
      ...(this.options.config.maxTokens !== undefined
        ? { maxTokens: this.options.config.maxTokens }
        : {}),
    };
  }

  private async restartRuntime(session: DshAcpSession): Promise<void> {
    session.unsubscribeNotification();
    session.unsubscribeApproval();
    session.unsubscribeExit();
    await session.runtimeSession.close();
    session.runtimeSession = await this.options.runtime.start(this.buildRuntimeStart(session));
    session.toolCalls.clear();
    this.bindRuntime(session);
  }

  private modelState(currentModelId: string): NonNullable<NewSessionResponse["models"]> {
    return {
      currentModelId,
      availableModels: this.catalog.models.map((model) => ({
        modelId: model.modelId,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
      })),
    };
  }

  private configOptions(session: DshAcpSession): SessionConfigOption[] {
    const model = this.requireModel(session.modelId);
    const efforts = model.reasoningEfforts ?? [];
    if (efforts.length === 0) {
      return [];
    }
    const currentValue =
      session.reasoningEffort && efforts.includes(session.reasoningEffort)
        ? session.reasoningEffort
        : efforts[0];
    if (!currentValue) {
      return [];
    }
    return [
      {
        id: "dsh-thinking",
        name: "Thinking",
        description: "DeepSeek Harness reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue,
        options: efforts.map((effort) => ({ value: effort, name: effortLabel(effort) })),
      },
    ];
  }

  private resolveConfiguredModelId(): string {
    if (!this.options.config.model) {
      return this.catalog.defaultModelId;
    }
    if (!this.options.config.provider || this.options.config.provider === "deepseek-official") {
      return this.options.config.model;
    }
    return `${this.options.config.provider}/${this.options.config.model}`;
  }

  private resolveInitialReasoningEffort(model: DshModelDefinition): string | null {
    const configured = this.catalog.defaultReasoningEffort;
    if (configured && model.reasoningEfforts?.includes(configured)) {
      return configured;
    }
    return model.reasoningEfforts?.includes("high") ? "high" : null;
  }

  private requireModel(modelId: string): DshModelDefinition {
    const model = this.catalog.models.find((entry) => entry.modelId === modelId);
    if (!model) {
      throw new Error(`Unknown DSH model: ${modelId}`);
    }
    return model;
  }

  private assertIdle(session: DshAcpSession): void {
    if (session.activePrompt) {
      throw new Error("DSH model, thinking, and permission changes require an idle session");
    }
  }

  private async refreshRuntimeCatalog(runtimeSession: DshRuntimeSession): Promise<void> {
    const runtimeModels = await runtimeSession.listModels();
    const models = new Map(this.catalog.models.map((model) => [model.modelId, model]));
    for (const model of runtimeModels) {
      const mapped = mapRuntimeModel(model);
      models.set(mapped.modelId, mapped);
    }
    this.catalog = { ...this.catalog, models: [...models.values()] };
  }

  private async handleApprovalRequest(
    session: DshAcpSession,
    request: DshApprovalRequest,
  ): Promise<void> {
    if (request.sessionId !== session.sessionId || session.closed) {
      request.respond("unavailable");
      return;
    }
    try {
      const response = await this.options.connection.requestPermission({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: request.callId ?? `dsh-approval-${randomUUID()}`,
          title: request.reason ?? request.toolName,
          kind: toolKind(request.toolName),
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      if (response.outcome.outcome === "cancelled") {
        request.respond("cancelled");
        return;
      }
      request.respond(response.outcome.optionId === "allow-once" ? "allowed-once" : "rejected");
    } catch {
      request.respond("unavailable");
    }
  }
}

function promptToText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return `[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]`;
      }
      throw new Error(`Unsupported prompt content: ${block.type}`);
    })
    .join("\n");
}

function isInboxReceipt(
  notification: DshNotification,
  sessionId: string,
  messageId: string,
): boolean {
  const event = getSessionEvent(notification, sessionId);
  if (event?.type !== "agent/inbox/spliced") {
    return false;
  }
  const data = asRecord(event.data);
  if (!Array.isArray(data?.inserted)) {
    return false;
  }
  return data.inserted.some((message) => asRecord(message)?.id === messageId);
}

function isSessionIdle(notification: DshNotification, sessionId: string): boolean {
  if (notification.method !== "session.status") {
    return false;
  }
  const params = asRecord(notification.params);
  return params?.sessionId === sessionId && params.status === "idle";
}

function mapNotification(
  notification: DshNotification,
  session: DshAcpSession,
  assistantMessageId: string,
): SessionNotification["update"] | null {
  const event = getSessionEvent(notification, session.sessionId);
  if (!event) {
    return null;
  }
  if (event.type === "assistant/chunk") {
    return mapAssistantChunk(event.data, assistantMessageId);
  }
  if (event.type === "tool/call") {
    return mapToolCall(event.data, session.toolCalls);
  }
  if (event.type === "tool/result") {
    return mapToolResult(event.data, session.toolCalls);
  }
  return null;
}

function mapAssistantChunk(
  data: unknown,
  assistantMessageId: string,
): SessionNotification["update"] | null {
  const chunk = asRecord(asRecord(data)?.chunk);
  if (typeof chunk?.text !== "string" || chunk.text.length === 0) {
    return null;
  }
  if (chunk.type === "text-delta") {
    return {
      sessionUpdate: "agent_message_chunk",
      messageId: assistantMessageId,
      content: { type: "text", text: chunk.text },
    };
  }
  if (chunk.type === "reasoning-delta") {
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: chunk.text },
    };
  }
  return null;
}

function mapToolCall(
  data: unknown,
  toolCalls: Map<string, { name: string; args: unknown }>,
): SessionNotification["update"] | null {
  const record = asRecord(data);
  if (!record) {
    return null;
  }
  const callId = typeof record.callId === "string" ? record.callId : null;
  if (!callId) {
    return null;
  }
  const name = typeof record.name === "string" ? record.name : "tool";
  const args = parseToolArguments(record.arguments);
  toolCalls.set(callId, { name, args });
  return {
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: name,
    kind: toolKind(name),
    status: "in_progress",
    rawInput: args,
  };
}

function mapToolResult(
  data: unknown,
  toolCalls: Map<string, { name: string; args: unknown }>,
): SessionNotification["update"] | null {
  const message = asRecord(asRecord(data)?.message);
  if (!Array.isArray(message?.content)) {
    return null;
  }
  const block = message.content.map(asRecord).find((entry) => entry?.type === "tool-result");
  if (!block) {
    return null;
  }
  const source = asRecord(message.source);
  let callId: string | null = null;
  if (typeof block.toolCallId === "string") {
    callId = block.toolCallId;
  } else if (typeof source?.callId === "string") {
    callId = source.callId;
  }
  if (!callId) {
    return null;
  }
  const output = toolResultText(block.content);
  const prior = toolCalls.get(callId);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    title: prior?.name ?? "tool",
    kind: toolKind(prior?.name ?? "tool"),
    status: block.isError === true ? "failed" : "completed",
    rawInput: prior?.args,
    rawOutput: output,
    content: output ? [{ type: "content", content: { type: "text", text: output } }] : undefined,
  };
}

function getSessionEvent(
  notification: DshNotification,
  sessionId: string,
): Record<string, unknown> | null {
  if (notification.method !== "session.event") {
    return null;
  }
  const params = asRecord(notification.params);
  if (params?.sessionId !== sessionId) {
    return null;
  }
  return asRecord(params.event);
}

function toolKind(name: string): "execute" | "read" | "edit" | "search" | "other" {
  if (name === "bash" || name.includes("terminal")) {
    return "execute";
  }
  if (name.includes("read")) {
    return "read";
  }
  if (name.includes("edit") || name.includes("write")) {
    return "edit";
  }
  if (name.includes("search") || name.includes("grep")) {
    return "search";
  }
  return "other";
}

function permissionModeState(
  currentModeId: DshPermissionMode,
): NonNullable<NewSessionResponse["modes"]> {
  return {
    currentModeId,
    availableModes: [
      {
        id: "ask",
        name: "Ask Before Tools",
        description: "Request one-shot approval before each DSH tool call",
      },
      {
        id: "read-only",
        name: "Read Only",
        description: "Allow observation tools and deny mutating or executable tools",
      },
      {
        id: "full-access",
        name: "Full Access",
        description: "Run DSH tools without approval prompts",
      },
    ],
  };
}

function isPermissionMode(value: string): value is DshPermissionMode {
  return value === "ask" || value === "read-only" || value === "full-access";
}

function effortLabel(effort: string): string {
  return effort
    .split(/[-_]/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function mapRuntimeModel(model: DshRuntimeModel): DshModelDefinition {
  const modelId =
    model.provider === "deepseek-official" ? model.id : `${model.provider}/${model.id}`;
  return {
    modelId,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.reasoningEfforts?.length
      ? { reasoningEfforts: model.reasoningEfforts.map((effort) => effort.id) }
      : {}),
  };
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? "" : JSON.stringify(value);
  }
  return value
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function createPromptDeferred(userMessageId: string | undefined): {
  active: ActivePrompt;
  promise: Promise<PromptResponse>;
} {
  let resolvePrompt: (response: PromptResponse) => void = () => undefined;
  let rejectPrompt: (error: Error) => void = () => undefined;
  const promise = new Promise<PromptResponse>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  return {
    active: {
      resolve: resolvePrompt,
      reject: rejectPrompt,
      dshMessageId: null,
      receivedInbox: false,
      receivedIdle: false,
      bufferedNotifications: [],
      assistantMessageId: randomUUID(),
      ...(userMessageId ? { userMessageId } : {}),
    },
    promise,
  };
}
