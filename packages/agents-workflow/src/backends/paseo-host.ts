/**
 * PaseoHostBackend — AgentBackend that talks to Paseo through an injected host
 * API (the same create→run→wait path the WebSocket protocol exposes), NOT via
 * shelling out to a `paseo` CLI on PATH.
 *
 * The engine package stays free of @getpaseo/server / @getpaseo/client deps;
 * the daemon (or a DaemonClient adapter) supplies `PaseoAgentHost`.
 *
 * Structured output stays engine-owned — this backend only returns final text.
 * contract: run() RESOLVES with { error } on ordinary failure (never rejects).
 */
import { AgentBackend, type AgentSpec, type AgentResult, type AgentUsage } from "../backend.js";

/** One agent invocation request, protocol-shaped. */
export interface PaseoAgentHostRequest {
  /**
   * The engine's per-`agent()` id (`AgentSpec.callId`). Lets the host tag what
   * it learns — spawned agentId, usage — onto the same progress-tree node the
   * engine's events created. Optional: older engines do not send it.
   */
  callId?: number;
  prompt: string;
  provider: string;
  model?: string;
  /** Thinking / reasoning option id (`createAgent.thinking`). */
  thinkingOptionId?: string;
  /** Provider mode id (`createAgent.mode`). */
  modeId?: string;
  /** Provider feature values (`createAgent.features`). */
  featureValues?: Record<string, unknown>;
  cwd?: string;
  workspaceId?: string;
  title?: string;
  labels?: Record<string, string>;
  /** When `"worktree"`, host should mint an isolated worktree workspace. */
  isolation?: string;
}

export interface PaseoAgentHostResult {
  text?: string;
  error?: string;
  usage?: AgentUsage;
  agentId?: string;
}

/**
 * Host seam — daemon implements this with createAgentCommand + AgentManager;
 * a future CLI adapter can implement it with DaemonClient RPCs.
 */
export interface PaseoAgentHost {
  runAgent(request: PaseoAgentHostRequest): Promise<PaseoAgentHostResult>;
}

export interface PaseoHostBackendOptions {
  host: PaseoAgentHost;
  /** Used when a spec omits provider (default "claude"). */
  defaultProvider?: string;
  /** Used when a spec omits model. */
  defaultModel?: string;
  /** Used when a spec omits effort. */
  defaultEffort?: string;
  /** Used when a spec omits mode. */
  defaultMode?: string;
  /** Merged under per-call `featureValues` (call wins on key clash). */
  defaultFeatureValues?: Record<string, unknown>;
  cwd?: string;
  /** Pin every agent to this workspace (required for non-worktree runs in daemon). */
  workspaceId?: string;
}

export class PaseoHostBackend extends AgentBackend {
  private readonly host: PaseoAgentHost;
  private readonly defaultProvider: string;
  private readonly defaultModel?: string;
  private readonly defaultEffort?: string;
  private readonly defaultMode?: string;
  private readonly defaultFeatureValues?: Record<string, unknown>;
  private readonly cwd?: string;
  private readonly workspaceId?: string;

  constructor(opts: PaseoHostBackendOptions) {
    super();
    this.host = opts.host;
    this.defaultProvider = opts.defaultProvider ?? "claude";
    this.defaultModel = opts.defaultModel;
    this.defaultEffort = opts.defaultEffort;
    this.defaultMode = opts.defaultMode;
    this.defaultFeatureValues = opts.defaultFeatureValues;
    this.cwd = opts.cwd;
    this.workspaceId = opts.workspaceId;
  }

  override get name(): string {
    return "paseo-host";
  }

  override async run(spec: AgentSpec): Promise<AgentResult> {
    const provider = (spec.provider ?? this.defaultProvider).trim();
    const model = (spec.model ?? this.defaultModel)?.trim() || undefined;
    if (!provider) {
      return { error: "paseo-host: provider is required" };
    }
    if (flagLike(provider) || flagLike(model)) {
      return {
        error: `paseo-host: unsafe provider/model value "${flagLike(provider) ?? flagLike(model)}"`,
      };
    }

    const isolation = spec.isolation === "worktree" ? "worktree" : undefined;
    const workspaceId = isolation === "worktree" ? undefined : this.workspaceId;
    if (!isolation && !workspaceId) {
      return {
        error:
          "paseo-host: workspaceId is required (daemon must pin one workspace per workflow run)",
      };
    }

    const effort = (spec.effort ?? this.defaultEffort)?.toString().trim() || undefined;
    const modeId = (spec.mode ?? this.defaultMode)?.trim() || undefined;
    const featureValues = mergeFeatureValues(this.defaultFeatureValues, spec.featureValues);

    try {
      const result = await this.host.runAgent({
        ...(spec.callId != null ? { callId: spec.callId } : {}),
        prompt: spec.prompt,
        provider,
        model,
        thinkingOptionId: effort,
        modeId,
        featureValues,
        cwd: this.cwd,
        workspaceId,
        title: spec.label ?? spec.phase ?? "workflow-agent",
        labels: spec.labels,
        isolation,
      });
      if (result.error) {
        return { error: result.error, usage: result.usage };
      }
      if (result.text == null || result.text === "") {
        return {
          error: "paseo-host: agent finished with empty assistant text",
          usage: result.usage,
        };
      }
      return { text: result.text, usage: result.usage };
    } catch (err) {
      return { error: `paseo-host: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

function flagLike(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  if (v.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(v)) return v;
  return undefined;
}

function mergeFeatureValues(
  defaults: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!defaults && !overrides) {
    return undefined;
  }
  const merged = { ...(defaults ?? {}), ...(overrides ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
