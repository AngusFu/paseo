/**
 * Daemon-side PaseoAgentHost — implements the agents-workflow host seam with
 * the same create→run→wait path the WebSocket protocol uses (createAgentCommand
 * + AgentManager), not a PATH `paseo` CLI subprocess.
 */
import type {
  PaseoAgentHost,
  PaseoAgentHostRequest,
  PaseoAgentHostResult,
} from "@getpaseo/agents-workflow";
import type { Logger } from "pino";
import { formatProviderModel, type BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { AgentManager } from "../agent/agent-manager.js";

export interface WorkflowPaseoAgentHostDeps {
  createAgent: BoundCreateAgentCommand;
  agentManager: Pick<AgentManager, "runAgent" | "waitForAgentEvent">;
  logger: Logger;
}

function worktreeSlug(title: string | undefined): string {
  const raw = title ?? "agent";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `flow-${slug || "agent"}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  // Thrown non-Error payloads (e.g. ACP error objects) — String() would
  // collapse them to "[object Object]" in run logs.
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

async function createWorkflowAgent(
  deps: WorkflowPaseoAgentHostDeps,
  request: PaseoAgentHostRequest,
  provider: string,
  isolation: "worktree" | undefined,
) {
  return deps.createAgent({
    kind: "mcp",
    provider,
    cwd: request.cwd,
    workspaceId: isolation ? undefined : request.workspaceId,
    title: request.title ?? "workflow-agent",
    thinking: request.thinkingOptionId,
    mode: request.modeId,
    features: request.featureValues,
    labels: {
      "paseo.workflow-agent": "1",
      ...request.labels,
    },
    unattended: true,
    promptFailure: "return-error",
    background: true,
    notifyOnFinish: false,
    ...(isolation
      ? {
          worktree: {
            worktreeName: worktreeSlug(request.title),
          },
        }
      : {}),
  });
}

async function finishWorkflowAgent(
  deps: WorkflowPaseoAgentHostDeps,
  agentId: string,
  prompt: string,
): Promise<PaseoAgentHostResult> {
  const result = await deps.agentManager.runAgent(agentId, prompt);
  const waitResult = await deps.agentManager.waitForAgentEvent(agentId, {
    waitForActive: true,
  });

  if (result.canceled) {
    return { error: `agent ${agentId} was canceled`, agentId };
  }
  if (waitResult.permission) {
    return { error: `agent ${agentId} is waiting for permission`, agentId };
  }
  if (waitResult.status === "error") {
    return {
      error: waitResult.lastMessage ?? `agent ${agentId} failed`,
      agentId,
    };
  }

  const text = result.finalText || waitResult.lastMessage || "";
  // Forward the provider's whole usage record. This is the completed turn's
  // usage (from `turn_completed`), not a running total — workflow agents run
  // exactly one turn, so for them the two coincide. Do not sum these across
  // turns if that ever changes: the context-window fields are a snapshot.
  return {
    text,
    agentId,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function createWorkflowPaseoAgentHost(deps: WorkflowPaseoAgentHostDeps): PaseoAgentHost {
  const logger = deps.logger.child({ module: "workflow-paseo-host" });

  return {
    async runAgent(request: PaseoAgentHostRequest): Promise<PaseoAgentHostResult> {
      const provider = formatProviderModel(request.provider, request.model ?? null);
      const isolation = request.isolation === "worktree" ? "worktree" : undefined;
      logger.info(
        {
          provider: request.provider,
          model: request.model ?? null,
          thinkingOptionId: request.thinkingOptionId ?? null,
          modeId: request.modeId ?? null,
          featureValues: request.featureValues ?? null,
          cwd: request.cwd,
          workspaceId: request.workspaceId ?? null,
          isolation: isolation ?? null,
          title: request.title ?? null,
        },
        "workflow agent run starting",
      );

      try {
        const created = await createWorkflowAgent(deps, request, provider, isolation);
        if (created.initialPromptError) {
          logger.error(
            { err: created.initialPromptError, agentId: created.snapshot.id, provider },
            "workflow agent create/initial prompt failed",
          );
          return {
            error: errorMessage(created.initialPromptError),
            agentId: created.snapshot.id,
          };
        }

        const finished = await finishWorkflowAgent(deps, created.snapshot.id, request.prompt);
        if (!finished.error) {
          logger.info(
            {
              agentId: finished.agentId,
              provider: request.provider,
              model: request.model ?? null,
              textChars: finished.text?.length ?? 0,
              outputTokens: finished.usage?.outputTokens ?? null,
            },
            "workflow agent run finished",
          );
        }
        return finished;
      } catch (err) {
        logger.error(
          { err, provider: request.provider, model: request.model ?? null, cwd: request.cwd },
          "workflow agent run failed",
        );
        return { error: errorMessage(err) };
      }
    },
  };
}
