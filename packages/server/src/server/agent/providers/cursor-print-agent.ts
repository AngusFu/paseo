import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Logger } from "pino";

import { McpCliService } from "../../mcp-cli/service.js";
import { PROSE_STOP_PREVENTION_PROMPT } from "../prose-stop/prevention-prompt.js";

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
  CURSOR_PRINT_BARE_EFFORT_ID,
  CURSOR_PRINT_FAST_MODE_FEATURE_ID,
  cursorPrintModelSupportsFast,
  groupCursorPrintModels,
  isCursorPrintWireModelId,
  matchCursorPrintCatalogFromDisplayLabel,
  normalizeCursorPrintBaseModelId,
  parseCursorPrintModelId,
  resolveCursorPrintWireModel,
  type CursorPrintRawModel,
} from "./cursor-print-models.js";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  isACPAutoAcceptEnabled,
  parseACPAutoAcceptFeatureValue,
} from "./acp-agent.js";
import { composeSystemPromptParts } from "../system-prompt.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { resolveOrMaterializeProviderImage } from "./provider-image-output.js";
import {
  materializeCursorPrintMcpPlugin,
  type CursorPrintMcpPlugin,
} from "./cursor-print-mcp-plugin.js";

export const CURSOR_PRINT_PROVIDER_ID = "cursor-print";
/** Prefer auto-review: many orgs disable --force / YOLO. */
export const CURSOR_PRINT_DEFAULT_MODE_ID = "auto-review";
const CURSOR_PRINT_DEFAULT_COMMAND = ["agent"] as const;
const MODELS_TIMEOUT_MS = 30_000;

/**
 * Cursor CLI has no reliable append-system-prompt. Daemon MCP is injected per
 * session via a temp `--plugin-dir` (see `cursor-print-mcp-plugin.ts`). Host
 * guidance is written once at daemon start to a file; each CLI turn only gets a
 * short XML pointer. Timeline user_message stays raw.
 *
 * Override path with PASEO_CURSOR_PRINT_PROMPT_FILE (tests / non-/tmp hosts).
 */
export const CURSOR_PRINT_RUNTIME_GUIDANCE = [
  "Paseo cursor-print: daemon MCP (paseo) is injected via --plugin-dir. Prefer MCP tools (ask_question, create_agent, …) when GetMcpTools lists them.",
  "Prefer project CLIs for tools that are also FastMCP CLIs: atlassian (Jira/Confluence), glab (GitLab; use env -u GITLAB_TOKEN glab …), figma, chrome-devtools, gh.",
  "If a skill/doc names a CLI, run that CLI — do not substitute an MCP server with the same job.",
  "Never use AskUserQuestion / AskQuestion (or similar IDE questionnaire tools): --print has no questionnaire UI and they return Questions skipped.",
  'To ask the user a decision: prefer MCP ask_question. On timeout / missing tool, use Paseo Question Inbox via Shell — `paseo question create --agent "$PASEO_AGENT_ID" --source skill --title "…" --questions \'[{"header":"…","question":"…","options":[{"label":"…"},{"label":"…"}]}]\' --json` then `paseo question wait <id> --timeout 30m --json`. Do not re-ask in chat prose; treat dismissed=true as a real outcome.',
  "Permission notes: Paseo Auto Approve only auto-answers Cursor interaction_query over stdin; it cannot enable org-disabled --force / Run Everything. Prefer Auto-review mode; do not rely on Force/YOLO when the org blocks it.",
].join("\n");

export const CURSOR_PRINT_PROMPT_FILE_DEFAULT = "/tmp/paseo-cursor-print-guidance.md";

export function resolveCursorPrintPromptFilePath(): string {
  const fromEnv = process.env.PASEO_CURSOR_PRINT_PROMPT_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : CURSOR_PRINT_PROMPT_FILE_DEFAULT;
}

/** Write guidance file contents. Returns the path. */
export function writeCursorPrintGuidanceFile(
  content: string,
  path: string = resolveCursorPrintPromptFilePath(),
): string {
  writeFileSync(path, `${content}\n`, "utf8");
  return path;
}

/**
 * Daemon boot: write host-level cursor-print guidance (runtime + daemon appends).
 * Per-agent systemPrompt is not included — that stays on the CLI wire when set.
 */
export async function writeCursorPrintGuidanceFileForDaemon(input: {
  paseoHome?: string;
  appendSystemPrompt?: string;
  includeProseStopPrevention?: boolean;
  path?: string;
}): Promise<string> {
  const parts: string[] = [CURSOR_PRINT_RUNTIME_GUIDANCE];
  const userAppend = input.appendSystemPrompt?.trim();
  if (userAppend) {
    parts.push(userAppend);
  }
  if (input.includeProseStopPrevention !== false) {
    parts.push(PROSE_STOP_PREVENTION_PROMPT.trim());
  }
  if (input.paseoHome) {
    try {
      const mcpPrompt = await new McpCliService(input.paseoHome).daemonAppendPrompt();
      if (mcpPrompt.trim().length > 0) {
        parts.push(mcpPrompt.trim());
      }
    } catch {
      // FastMCP CLI overlay is best-effort at boot.
    }
  }
  const content = composeSystemPromptParts(...parts) ?? CURSOR_PRINT_RUNTIME_GUIDANCE;
  return writeCursorPrintGuidanceFile(content, input.path ?? resolveCursorPrintPromptFilePath());
}

export function buildCursorPrintPromptPointer(path: string): string {
  return `<paseo_guidance>Read ${path} if unread this session; follow it.</paseo_guidance>`;
}

/**
 * Build the prompt string passed to `agent --print` (not the timeline user row).
 * Does not write the guidance file — daemon boot owns that.
 */
export function buildCursorPrintCliPrompt(
  userText: string,
  config: Pick<AgentSessionConfig, "systemPrompt" | "daemonAppendSystemPrompt"> = {},
  options?: { promptFilePath?: string },
): string {
  const path = options?.promptFilePath ?? resolveCursorPrintPromptFilePath();
  const pointer = buildCursorPrintPromptPointer(path);
  // Host daemonAppend lives in the guidance file; only per-agent systemPrompt stays here.
  const agentPrompt = config.systemPrompt?.trim();
  const head = agentPrompt ? `${pointer}\n${agentPrompt}` : pointer;
  const trimmed = userText.trim();
  if (!trimmed) {
    return head;
  }
  return `${head}\n\n${trimmed}`;
}

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  // Consumed via temp --plugin-dir (Cursor has no --mcp-config for print).
  supportsMcpServers: true,
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
  /** One retry when Cursor returns "Cannot use this model" with an empty catalog. */
  allowEmptyModelCatalogRetry: boolean;
  /** Prompt passed to Cursor CLI (includes runtime guidance / system prompts). */
  promptText: string;
  /** Raw user text for timeline user_message / retries (no CLI `@path` wire mentions). */
  userText: string;
  /** Materialized image paths for Cursor CLI `--image` (resume retries reuse these). */
  imagePaths: string[];
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

export interface CursorPrintConvertedPrompt {
  /** Raw user-visible text for the timeline `user_message` (no CLI `@path` mentions). */
  timelineText: string;
  /** Wire prompt text for Cursor CLI (includes `@path` image mentions). */
  wireText: string;
  imagePaths: string[];
}

/**
 * Convert a Paseo prompt into Cursor CLI inputs + timeline text.
 * Images are materialized once (content-hash path reuse) and attached two ways on the wire:
 * 1. `--image <path>` (native Cursor headless attach)
 * 2. `@<path>` in the CLI prompt text (so Read/@-file still works if --image is ignored)
 * Timeline text stays raw — never bake `@path` into the user_message row.
 */
export function convertCursorPrintPrompt(prompt: AgentPromptInput): CursorPrintConvertedPrompt {
  if (typeof prompt === "string") {
    return { timelineText: prompt, wireText: prompt, imagePaths: [] };
  }

  const timelineParts: string[] = [];
  const wireParts: string[] = [];
  const imagePaths: string[] = [];
  const seenImagePaths = new Set<string>();

  for (const block of prompt) {
    if (block.type === "text") {
      timelineParts.push(block.text);
      wireParts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      try {
        const materialized = resolveOrMaterializeProviderImage({
          data: block.data,
          mimeType: block.mimeType,
          path: block.path,
        });
        if (!seenImagePaths.has(materialized.path)) {
          seenImagePaths.add(materialized.path);
          imagePaths.push(materialized.path);
          // Dual path: Cursor @-file mention in addition to --image (CLI only).
          wireParts.push(`@${materialized.path}`);
        }
      } catch (error) {
        const omitted = `[Image attachment omitted: failed to write local file (${toDiagnosticErrorMessage(error)})]`;
        timelineParts.push(omitted);
        wireParts.push(omitted);
      }
      continue;
    }
    const rendered = renderPromptAttachmentAsText(block);
    timelineParts.push(rendered);
    wireParts.push(rendered);
  }

  return {
    timelineText: timelineParts.join("\n\n").trim(),
    wireText: wireParts.join("\n\n").trim(),
    imagePaths,
  };
}

/** Cursor rejected `--model` and returned an empty Available models list (transient catalog miss). */
export function isCursorEmptyModelCatalogFailure(error: string): boolean {
  const match = error.match(/Cannot use this model:\s*.+?\.\s*Available models:\s*(.*)$/is);
  if (!match) {
    return false;
  }
  const listed = match[1]
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "Available models" && !line.startsWith("Tip:"))
    .join(" ")
    .trim();
  return listed.length === 0;
}

/** Rewrite Cursor model rejections into a shorter, actionable timeline error. */
export function formatCursorPrintModelRejection(error: string): string {
  const match = error.match(/Cannot use this model:\s*(.+?)\.\s*Available models:\s*(.*)$/is);
  if (!match) {
    return error;
  }
  const rejected = match[1].trim();
  const listed = match[2]
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "Available models" && !part.startsWith("Tip:"));
  if (listed.length === 0) {
    return `Cursor rejected model ${rejected} (empty model catalog from CLI). Retry the turn, or switch model/effort/Fast.`;
  }
  const preview = listed.slice(0, 8).join(", ");
  const more = listed.length > 8 ? `, …(+${listed.length - 8})` : "";
  return `Cursor rejected model ${rejected}. Available: ${preview}${more}`;
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

function parseRawModelsOutput(stdout: string): CursorPrintRawModel[] {
  const models: CursorPrintRawModel[] = [];
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
      id,
      label: label || id,
      isDefault: /\(current\)/i.test(line) || /\(default\)/i.test(line),
    });
  }
  return models;
}

function parseModelsOutput(stdout: string, provider: AgentProvider): AgentModelDefinition[] {
  return groupCursorPrintModels(parseRawModelsOutput(stdout), provider);
}

export function buildCursorPrintFastModeFeature(enabled: boolean): AgentFeature {
  return {
    type: "toggle",
    id: CURSOR_PRINT_FAST_MODE_FEATURE_ID,
    label: "Fast",
    description: "Use the Cursor fast variant of the selected model",
    tooltip: "Toggle fast model variant",
    icon: "zap",
    value: enabled,
  };
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
  imagePaths?: readonly string[];
  pluginDirs?: readonly string[];
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

  // Session-scoped MCP from config.mcpServers (daemon paseo + user servers).
  const pluginDirs = options.pluginDirs ?? [];
  if (pluginDirs.length > 0) {
    for (const pluginDir of pluginDirs) {
      args.push("--plugin-dir", pluginDir);
    }
    args.push("--approve-mcps");
  }

  if (options.resumeChatId) {
    args.push("--resume", options.resumeChatId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  // Hidden Cursor CLI flag: attach image(s) to a headless prompt (repeatable).
  for (const imagePath of options.imagePaths ?? []) {
    args.push("--image", imagePath);
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

function catalogForLabelRecovery(
  catalogModel?: AgentModelDefinition | null,
  catalogModels?: readonly AgentModelDefinition[] | null,
): readonly AgentModelDefinition[] {
  if (catalogModels && catalogModels.length > 0) {
    return catalogModels;
  }
  if (catalogModel) {
    return [catalogModel];
  }
  return [];
}

function nonBareEffortId(effortId: string | null | undefined): string | null {
  if (typeof effortId !== "string" || effortId.trim().length === 0) {
    return null;
  }
  if (effortId === CURSOR_PRINT_BARE_EFFORT_ID) {
    return null;
  }
  return effortId;
}

function recoverCursorPrintModelInput(
  model: string | null | undefined,
  catalogModel?: AgentModelDefinition | null,
  catalogModels?: readonly AgentModelDefinition[] | null,
): {
  modelInput: string | undefined;
  recoveredFromLabel: ReturnType<typeof matchCursorPrintCatalogFromDisplayLabel>;
} {
  if (typeof model !== "string" || !model.trim()) {
    return { modelInput: undefined, recoveredFromLabel: null };
  }
  if (isCursorPrintWireModelId(model)) {
    return { modelInput: model, recoveredFromLabel: null };
  }
  const recoveredFromLabel = matchCursorPrintCatalogFromDisplayLabel(
    model,
    catalogForLabelRecovery(catalogModel, catalogModels),
  );
  return { modelInput: recoveredFromLabel?.baseId, recoveredFromLabel };
}

/**
 * Collapse legacy wire model ids into catalog base + thinking/fast config.
 * Cursor CLI still receives the concrete wire id at launch time.
 * Display labels (from system/init) are recovered via catalog when possible.
 */
export function normalizeCursorPrintSessionConfig(
  config: AgentSessionConfig,
  catalogModel?: AgentModelDefinition | null,
  catalogModels?: readonly AgentModelDefinition[] | null,
): AgentSessionConfig {
  const { modelInput, recoveredFromLabel } = recoverCursorPrintModelInput(
    config.model,
    catalogModel,
    catalogModels,
  );
  const parsed = parseCursorPrintModelId(modelInput);
  const baseId = normalizeCursorPrintBaseModelId(modelInput) ?? undefined;
  const configuredThinking =
    typeof config.thinkingOptionId === "string" && config.thinkingOptionId.trim().length > 0
      ? config.thinkingOptionId
      : null;
  const thinkingOptionId =
    configuredThinking ??
    nonBareEffortId(parsed?.effortId) ??
    nonBareEffortId(recoveredFromLabel?.effortId) ??
    catalogModel?.defaultThinkingOptionId ??
    undefined;

  const featureValues: Record<string, unknown> = { ...config.featureValues };
  const inferredFast = parsed?.fast === true || recoveredFromLabel?.fast === true;
  if (featureValues[CURSOR_PRINT_FAST_MODE_FEATURE_ID] == null && inferredFast) {
    featureValues[CURSOR_PRINT_FAST_MODE_FEATURE_ID] = true;
  }

  // Drop unrecovered display labels so they never become --model.
  return {
    ...config,
    ...(baseId ? { model: baseId } : { model: undefined }),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
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

function buildCursorPrintFeatures(options: {
  config: AgentSessionConfig;
  catalogModel?: AgentModelDefinition | null;
}): AgentFeature[] {
  const features: AgentFeature[] = [buildCursorPrintAutoAcceptFeature(options.config)];
  const fastEnabled = options.config.featureValues?.[CURSOR_PRINT_FAST_MODE_FEATURE_ID] === true;
  if (cursorPrintModelSupportsFast(options.catalogModel) || fastEnabled) {
    features.push(buildCursorPrintFastModeFeature(fastEnabled));
  }
  return features;
}

export class CursorPrintAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly label?: string;
  private readonly spawn: CursorPrintSpawn;
  private readonly execModels: (command: string, args: string[], cwd: string) => Promise<string>;
  private catalogModelsById = new Map<string, AgentModelDefinition>();

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

  private rememberCatalogModels(models: AgentModelDefinition[]): void {
    this.catalogModelsById = new Map(models.map((model) => [model.id, model]));
  }

  private async ensureCatalogModel(
    cwd: string,
    modelId: string | null | undefined,
  ): Promise<AgentModelDefinition | null> {
    const baseId = normalizeCursorPrintBaseModelId(modelId);
    if (!baseId) {
      return null;
    }
    const cached = this.catalogModelsById.get(baseId);
    if (cached) {
      return cached;
    }
    try {
      await this.fetchCatalog({ scope: "workspace", cwd, force: false });
    } catch (error) {
      this.logger.warn(
        { err: error, modelId: baseId, cwd },
        "cursor-print: catalog probe failed; wire model composition has no allow-list",
      );
      return null;
    }
    const model = this.catalogModelsById.get(baseId) ?? null;
    if (!model) {
      this.logger.warn(
        { modelId: baseId, cwd, known: [...this.catalogModelsById.keys()] },
        "cursor-print: model missing from catalog after probe",
      );
    }
    return model;
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
    const absolute = withAbsoluteCwd({ ...config, provider: this.provider });
    if (absolute.model && !isCursorPrintWireModelId(absolute.model)) {
      try {
        await this.fetchCatalog({ scope: "workspace", cwd: absolute.cwd, force: false });
      } catch {
        // normalize will drop the unrecovered label
      }
    }
    const catalogModels = [...this.catalogModelsById.values()];
    const catalogModel = await this.ensureCatalogModel(
      absolute.cwd,
      normalizeCursorPrintSessionConfig(absolute, null, catalogModels).model,
    );
    return new CursorPrintAgentSession({
      config: normalizeCursorPrintSessionConfig(absolute, catalogModel, catalogModels),
      catalogModel,
      catalogModelsById: this.catalogModelsById,
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

    const absolute = withAbsoluteCwd({
      cwd,
      ...metadata,
      ...overrides,
      provider: this.provider,
    });
    // Probe catalog before normalize so display-label recovery can match.
    if (absolute.model && !isCursorPrintWireModelId(absolute.model)) {
      try {
        await this.fetchCatalog({ scope: "workspace", cwd: absolute.cwd, force: false });
      } catch {
        // normalize will drop the unrecovered label
      }
    }
    const catalogModels = [...this.catalogModelsById.values()];
    const catalogModel = await this.ensureCatalogModel(
      absolute.cwd,
      normalizeCursorPrintSessionConfig(absolute, null, catalogModels).model,
    );
    return new CursorPrintAgentSession({
      config: normalizeCursorPrintSessionConfig(absolute, catalogModel, catalogModels),
      catalogModel,
      catalogModelsById: this.catalogModelsById,
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
      const models = parseModelsOutput(stdout, this.provider);
      this.rememberCatalogModels(models);
      return {
        models,
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
    const catalogModel = config.model
      ? await this.ensureCatalogModel(config.cwd, config.model)
      : null;
    return buildCursorPrintFeatures({
      config: normalizeCursorPrintSessionConfig(config, catalogModel),
      catalogModel,
    });
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
  catalogModel?: AgentModelDefinition | null;
  catalogModelsById?: Map<string, AgentModelDefinition>;
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
  private catalogModel: AgentModelDefinition | null;
  private catalogModelsById: Map<string, AgentModelDefinition>;
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
  private mcpPlugin: CursorPrintMcpPlugin | null = null;
  private mcpPluginResolved = false;

  constructor(options: CursorPrintAgentSessionOptions) {
    this.config = options.config;
    this.catalogModelsById = options.catalogModelsById ?? new Map();
    this.catalogModel =
      options.catalogModel ??
      (options.config.model ? (this.catalogModelsById.get(options.config.model) ?? null) : null);
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

  private ensureMcpPlugin(): CursorPrintMcpPlugin | null {
    if (this.mcpPluginResolved) {
      return this.mcpPlugin;
    }
    this.mcpPluginResolved = true;
    try {
      this.mcpPlugin = materializeCursorPrintMcpPlugin(this.config.mcpServers);
      if (this.mcpPlugin) {
        this.logger.debug(
          {
            pluginDir: this.mcpPlugin.pluginDir,
            servers: Object.keys(this.config.mcpServers ?? {}),
          },
          "cursor-print: materialized MCP plugin-dir",
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "cursor-print: failed to materialize MCP plugin-dir");
      this.mcpPlugin = null;
    }
    return this.mcpPlugin;
  }

  get id(): string | null {
    return this.chatId;
  }

  get features(): AgentFeature[] {
    return buildCursorPrintFeatures({
      config: this.config,
      catalogModel: this.catalogModel,
    });
  }

  private assertModelSelectionUnlocked(action: string): void {
    if (this.chatId) {
      throw new Error(`cursor-print does not support ${action} after the session has started`);
    }
  }

  private recoverModelIdFromDisplayLabel(label: string): string | null {
    const matched = matchCursorPrintCatalogFromDisplayLabel(label, [
      ...this.catalogModelsById.values(),
    ]);
    if (!matched) {
      return null;
    }
    this.logger.warn(
      { reportedModel: label, recoveredBaseId: matched.baseId },
      "cursor-print: recovered catalog model from display label",
    );
    this.modelId = matched.baseId;
    this.config.model = matched.baseId;
    if (!this.config.thinkingOptionId && matched.effortId !== CURSOR_PRINT_BARE_EFFORT_ID) {
      this.config.thinkingOptionId = matched.effortId;
    }
    if (this.config.featureValues?.[CURSOR_PRINT_FAST_MODE_FEATURE_ID] == null) {
      this.config.featureValues = {
        ...this.config.featureValues,
        [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: matched.fast,
      };
    }
    this.catalogModel = this.catalogModelsById.get(matched.baseId) ?? this.catalogModel;
    return matched.baseId;
  }

  private resolveWireModelId(): string | null {
    let modelId = this.modelId;
    if (modelId && !isCursorPrintWireModelId(modelId)) {
      modelId = this.recoverModelIdFromDisplayLabel(modelId);
      if (!modelId) {
        this.logger.error(
          { model: this.modelId },
          "cursor-print: refusing to pass display label as --model",
        );
        return null;
      }
    }
    const wire = resolveCursorPrintWireModel({
      modelId,
      thinkingOptionId: this.config.thinkingOptionId,
      fast: this.config.featureValues?.[CURSOR_PRINT_FAST_MODE_FEATURE_ID] === true,
      model: this.catalogModel,
    });
    if (wire && !this.catalogModel) {
      this.logger.warn(
        {
          model: modelId,
          thinkingOptionId: this.config.thinkingOptionId ?? null,
          fast: this.config.featureValues?.[CURSOR_PRINT_FAST_MODE_FEATURE_ID] === true,
          wire,
        },
        "cursor-print: composing wire model without catalog allow-list",
      );
    }
    return wire;
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
    const { timelineText, wireText, imagePaths } = convertCursorPrintPrompt(prompt);
    const cliPrompt = buildCursorPrintCliPrompt(wireText, this.config);
    this.launchTurnProcess({
      turnId,
      assistantMessageId,
      userText: timelineText,
      cliPrompt,
      imagePaths,
      resumeChatId: this.chatId,
      allowResumeFallback: Boolean(this.chatId),
      allowEmptyModelCatalogRetry: true,
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
    imagePaths: readonly string[];
    resumeChatId: string | null;
    allowResumeFallback: boolean;
    allowEmptyModelCatalogRetry: boolean;
    emitTurnStarted: boolean;
    clientMessageId?: string;
  }): void {
    const wireModel = this.resolveWireModelId();
    const mcpPlugin = this.ensureMcpPlugin();
    const args = buildTurnArgs({
      extraArgs: this.command.args,
      modeId: this.modeId,
      model: wireModel,
      resumeChatId: options.resumeChatId,
      workspace: this.config.cwd,
      prompt: options.cliPrompt,
      imagePaths: options.imagePaths,
      pluginDirs: mcpPlugin ? [mcpPlugin.pluginDir] : undefined,
    });

    this.logger.debug(
      {
        resume: Boolean(options.resumeChatId),
        resumeChatId: options.resumeChatId,
        modeId: this.modeId,
        model: this.modelId,
        wireModel,
        thinkingOptionId: this.config.thinkingOptionId ?? null,
        fast: this.config.featureValues?.[CURSOR_PRINT_FAST_MODE_FEATURE_ID] === true,
        cwd: this.config.cwd,
        pluginDir: mcpPlugin?.pluginDir ?? null,
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
      allowEmptyModelCatalogRetry: options.allowEmptyModelCatalogRetry,
      promptText: options.cliPrompt,
      userText: options.userText,
      imagePaths: [...options.imagePaths],
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
      thinkingOptionId: this.config.thinkingOptionId ?? null,
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
        thinkingOptionId: this.config.thinkingOptionId,
        featureValues: this.config.featureValues,
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
    if (this.mcpPlugin) {
      try {
        this.mcpPlugin.cleanup();
      } catch (error) {
        this.logger.warn({ err: error }, "cursor-print: failed to cleanup MCP plugin-dir");
      }
      this.mcpPlugin = null;
    }
  }

  async setModel(modelId: string | null): Promise<void> {
    this.assertModelSelectionUnlocked("changing the model");
    const parsed = parseCursorPrintModelId(modelId);
    this.modelId = parsed?.baseId ?? (typeof modelId === "string" ? modelId.trim() || null : null);
    this.config.model = this.modelId ?? undefined;
    this.catalogModel = this.modelId ? (this.catalogModelsById.get(this.modelId) ?? null) : null;
    if (parsed && parsed.effortId !== CURSOR_PRINT_BARE_EFFORT_ID) {
      this.config.thinkingOptionId = parsed.effortId;
    } else {
      this.config.thinkingOptionId = this.catalogModel?.defaultThinkingOptionId;
    }
    // Wire id encodes fast — always rewrite so stale fast_mode cannot leak across models.
    this.config.featureValues = {
      ...this.config.featureValues,
      [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: parsed?.fast === true,
    };
    this.emit({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: await this.getRuntimeInfo(),
    });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.assertModelSelectionUnlocked("changing thinking/effort");
    this.config.thinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId.trim()
        : undefined;
    this.emit({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: await this.getRuntimeInfo(),
    });
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === CURSOR_PRINT_FAST_MODE_FEATURE_ID) {
      this.assertModelSelectionUnlocked("changing fast mode");
      const enabled = Boolean(value);
      if (enabled && this.catalogModel && !cursorPrintModelSupportsFast(this.catalogModel)) {
        throw new Error(
          `Cursor print fast mode is not available for model '${this.modelId ?? "default"}'`,
        );
      }
      this.config.featureValues = {
        ...this.config.featureValues,
        [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: enabled,
      };
      this.emit({
        type: "model_changed",
        provider: this.provider,
        runtimeInfo: await this.getRuntimeInfo(),
      });
      return;
    }
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
    if (!model) {
      return;
    }
    // Cursor system/init reports a *display label* ("Cursor Grok 4.5 High Fast"),
    // not a CLI wire id. Only wire ids may update session model state — otherwise
    // the next turn passes the label to `--model` and Cursor rejects it.
    const parsed = parseCursorPrintModelId(model);
    if (!parsed) {
      this.logger.debug(
        { reportedModel: model, keptModel: this.modelId },
        "cursor-print: ignoring non-wire model from system init",
      );
      return;
    }
    this.modelId = parsed.baseId;
    this.config.model = parsed.baseId;
    if (!this.config.thinkingOptionId && parsed.effortId !== CURSOR_PRINT_BARE_EFFORT_ID) {
      this.config.thinkingOptionId = parsed.effortId;
    }
    this.config.featureValues = {
      ...this.config.featureValues,
      [CURSOR_PRINT_FAST_MODE_FEATURE_ID]: parsed.fast,
    };
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
    if (isError) {
      const error = readString(raw.result) ?? "cursor-print turn failed";
      if (this.tryRetryActiveTurn(error)) {
        return;
      }
    }

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
        error: formatCursorPrintModelRejection(
          readString(raw.result) ?? "cursor-print turn failed",
        ),
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

    if (this.tryRetryActiveTurn(error)) {
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
      error: formatCursorPrintModelRejection(error),
    });
  }

  /** Resume-miss or empty-model-catalog retries. Returns true when a relaunch was started. */
  private tryRetryActiveTurn(error: string): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.completed) {
      return false;
    }

    // cc-connect engine pattern: resume/continue failure → clear id and retry fresh.
    if (turn.allowResumeFallback && turn.resumedWith && isCursorResumeFailure(error)) {
      this.logger.warn(
        { sessionId: turn.resumedWith, error },
        "cursor-print: resume failed; retrying as fresh session",
      );
      this.clearPendingInteractions(turn, "Resume failed; retrying");
      this.replaceActiveTurnChild(turn);
      this.chatId = null;
      this.launchTurnProcess({
        turnId: turn.turnId,
        assistantMessageId: turn.assistantMessageId,
        userText: turn.userText,
        cliPrompt: turn.promptText,
        imagePaths: turn.imagePaths,
        resumeChatId: null,
        allowResumeFallback: false,
        allowEmptyModelCatalogRetry: turn.allowEmptyModelCatalogRetry,
        emitTurnStarted: false,
      });
      return true;
    }

    if (turn.allowEmptyModelCatalogRetry && isCursorEmptyModelCatalogFailure(error)) {
      this.logger.warn(
        { error, wireModel: this.resolveWireModelId() },
        "cursor-print: empty model catalog; retrying turn once",
      );
      this.clearPendingInteractions(turn, "Empty model catalog; retrying");
      this.replaceActiveTurnChild(turn);
      turn.allowEmptyModelCatalogRetry = false;
      this.launchTurnProcess({
        turnId: turn.turnId,
        assistantMessageId: turn.assistantMessageId,
        userText: turn.userText,
        cliPrompt: turn.promptText,
        imagePaths: turn.imagePaths,
        resumeChatId: turn.resumedWith,
        allowResumeFallback: turn.allowResumeFallback,
        allowEmptyModelCatalogRetry: false,
        emitTurnStarted: false,
      });
      return true;
    }

    return false;
  }

  private replaceActiveTurnChild(turn: ActiveTurn): void {
    const child = turn.child;
    turn.child = null;
    if (child) {
      void terminateWithTreeKill(child, {
        gracefulTimeoutMs: 2_000,
        forceTimeoutMs: 2_000,
      });
    }
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
