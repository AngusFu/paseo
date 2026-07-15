/**
 * MockBackend — the reference AgentBackend implementation.
 *
 * It is "just another backend": the engine cannot tell it apart from a real
 * one. Use it for tests and for developing the engine with zero infrastructure.
 *
 * Because structured output is an ENGINE concern, the mock needs no special
 * schema logic — it simply returns whatever text its responder produces (which
 * may be a JSON string). Latency is simulated with setTimeout, so vitest's fake
 * timers can fast-forward it for instant, deterministic tests.
 */
import { AgentBackend, type AgentSpec, type AgentResult } from "../backend.js";
import { synthesize } from "../schema-normalize.js";

export type MockReply =
  | { text?: string; error?: string; usage?: { outputTokens?: number } }
  | string;
export type MockResponder = (spec: AgentSpec) => MockReply | Promise<MockReply>;

export interface MockBackendConfig {
  respond?: MockResponder;
  /** Simulated per-agent latency (virtual-time friendly). */
  latencyMs?: number;
  /** If set, synthesize usage.outputTokens from text length. */
  tokensPerChar?: number;
}

export class MockBackend extends AgentBackend {
  readonly calls: AgentSpec[] = [];
  private readonly respond: MockResponder;
  private readonly latencyMs: number;
  private readonly tokensPerChar: number;

  constructor(cfg: MockBackendConfig = {}) {
    super();
    this.respond = cfg.respond ?? ((): MockReply => ({ text: "" }));
    this.latencyMs = cfg.latencyMs ?? 0;
    this.tokensPerChar = cfg.tokensPerChar ?? 0;
  }

  override get name(): string {
    return "mock";
  }

  override async run(spec: AgentSpec): Promise<AgentResult> {
    this.calls.push(spec);
    if (this.latencyMs > 0) await new Promise<void>((res) => setTimeout(res, this.latencyMs));
    let out = this.respond(spec);
    if (out && typeof (out as Promise<MockReply>).then === "function") out = await out;
    if (typeof out === "string") out = { text: out };
    const reply = (out ?? {}) as {
      text?: string;
      error?: string;
      usage?: { outputTokens?: number };
    };
    const result: AgentResult = { text: reply.text, error: reply.error, usage: reply.usage };
    if (!result.usage && this.tokensPerChar && typeof result.text === "string") {
      result.usage = { outputTokens: Math.ceil(result.text.length * this.tokensPerChar) };
    }
    return result;
  }

  /**
   * Auto responder for deterministic dry-runs: if the prompt embeds a
   * "JSON Schema:" block (as the engine's structuredPersona does), synthesize a
   * minimal valid instance and return it as JSON text; otherwise return a short
   * stub string. Lets any workflow run end-to-end producing real-shaped output.
   */
  static auto({ stub = "stub" }: { stub?: string } = {}): MockResponder {
    return (spec: AgentSpec) => {
      // structuredPersona ends the persona with "JSON Schema:\n{...}", then the
      // engine appends "\n\n---\n\n<task>". Capture just the schema object.
      const m = /JSON Schema:\s*\n([\s\S]*?)(?:\n\n---|$)/.exec(spec.prompt);
      if (m) {
        try {
          const schema = JSON.parse(m[1]) as Record<string, unknown>;
          return { text: JSON.stringify(synthesize(schema)) };
        } catch {
          /* fall through to stub */
        }
      }
      return { text: stub };
    };
  }

  /** Convenience: build a keyword->reply responder. First matching keyword wins. */
  static scripted(
    map: Record<string, MockReply | ((spec: AgentSpec) => MockReply)>,
    { fallback = { text: "" } as MockReply | ((spec: AgentSpec) => MockReply) } = {},
  ): MockResponder {
    return (spec: AgentSpec) => {
      const hay = `${spec.label ?? ""} ${spec.phase ?? ""} ${spec.prompt ?? ""}`;
      for (const [kw, reply] of Object.entries(map)) {
        if (hay.includes(kw)) return typeof reply === "function" ? reply(spec) : reply;
      }
      return typeof fallback === "function" ? fallback(spec) : fallback;
    };
  }
}
