import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";

export const name = "dsh-acp-sdk-jsonrpc-server";
export const inject = ["agents", "llm"];

interface InitializeParams {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

interface ResumeParams {
  sessionId: string;
}

interface ServerInternals {
  sessions: Map<string, { handle: AgentHandle }>;
}

export function apply(ctx: Context & { agents: AgentRegistry; llm: LlmRuntime }): void {
  const rootFiber = ctx.root.fiber;
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  const server = new HarnessSdkJsonRpcServer(ctx, transport);
  const internals = server as unknown as ServerInternals;
  let initialized: InitializeParams | null = null;
  let exitTask: Promise<void> | undefined;

  async function disposeAndExit(): Promise<void> {
    exitTask ??= (async () => {
      await Promise.allSettled([transport.flush()]);
      await Promise.allSettled([rootFiber.dispose()]);
      process.exit(0);
    })();
    await exitTask;
  }

  transport.onRequest(async (method, params) => {
    if (method === "initialize") {
      await ctx.get("loader")?.await();
      initialized = parseInitializeParams(params);
    }
    if (method === "session/resume") {
      if (!initialized) {
        throw new Error("session/resume requires initialize first");
      }
      const resume = parseResumeParams(params);
      if (internals.sessions.has(resume.sessionId)) {
        throw new Error(`session already open: ${resume.sessionId}`);
      }
      const handle = await ctx.agents.resume({
        resumeSessionId: SessionId(resume.sessionId),
        agentOptions: {
          provider: initialized.provider,
          model: initialized.model,
          ...(initialized.maxTokens !== undefined ? { maxTokens: initialized.maxTokens } : {}),
        },
      });
      internals.sessions.set(resume.sessionId, { handle });
      return {};
    }
    if (method === "catalog/list") {
      return listRuntimeModels(ctx.llm);
    }
    const result = await server.handleRequest(method, params);
    if (method === "shutdown") {
      setImmediate(() => void disposeAndExit());
    }
    return result;
  });

  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "dsh-acp-jsonrpc.serve");
}

async function listRuntimeModels(llm: LlmRuntime): Promise<{
  models: Array<{
    provider: string;
    id: string;
    name: string;
    description?: string;
    reasoningEfforts?: Array<{ id: string; name: string; description?: string }>;
    defaultReasoningEffort?: string;
  }>;
}> {
  const models = [];
  for (const provider of llm.listProviders()) {
    for (const model of await llm.listModels(provider.id)) {
      const resolved = await llm.resolveModelInfo(provider.id, model.id);
      models.push({
        provider: provider.id,
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(resolved.reasoning
          ? {
              reasoningEfforts: resolved.reasoning.efforts.map((effort) => ({
                id: String(effort.id),
                name: effort.name,
                ...(effort.description ? { description: effort.description } : {}),
              })),
              ...(resolved.reasoning.defaultEffort
                ? { defaultReasoningEffort: String(resolved.reasoning.defaultEffort) }
                : {}),
            }
          : {}),
      });
    }
  }
  return { models };
}

function parseInitializeParams(params: Record<string, unknown>): InitializeParams {
  if (
    typeof params.cwd !== "string" ||
    typeof params.provider !== "string" ||
    typeof params.model !== "string"
  ) {
    throw new Error("invalid initialize params");
  }
  return {
    cwd: params.cwd,
    provider: params.provider,
    model: params.model,
    ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
  };
}

function parseResumeParams(params: Record<string, unknown>): ResumeParams {
  if (typeof params.sessionId !== "string" || !params.sessionId) {
    throw new Error("invalid session/resume params");
  }
  return { sessionId: params.sessionId };
}
