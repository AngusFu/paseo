import type { KnowledgeBaseMountSelection } from "./mount-selection";

export interface KnowledgeBaseMountClient {
  knowledgeBaseMount(options: {
    workspaceId: string;
    idOrSlug: string;
    mountSlug?: string;
  }): Promise<{ error: string | null }>;
}

export interface MountSelectionFailure {
  idOrSlug: string;
  mountSlug: string;
  error: string;
}

export interface MountSelectionsResult {
  mounted: string[];
  failures: MountSelectionFailure[];
}

/** Sequentially mount selections after workspace create; never throws for RPC errors. */
export async function mountKnowledgeBaseSelections(input: {
  client: KnowledgeBaseMountClient;
  workspaceId: string;
  selections: readonly KnowledgeBaseMountSelection[];
}): Promise<MountSelectionsResult> {
  const mounted: string[] = [];
  const failures: MountSelectionFailure[] = [];

  for (const selection of input.selections) {
    try {
      const payload = await input.client.knowledgeBaseMount({
        workspaceId: input.workspaceId,
        idOrSlug: selection.idOrSlug,
        mountSlug: selection.mountSlug,
      });
      if (payload.error) {
        failures.push({
          idOrSlug: selection.idOrSlug,
          mountSlug: selection.mountSlug,
          error: payload.error,
        });
        continue;
      }
      mounted.push(selection.mountSlug);
    } catch (error) {
      failures.push({
        idOrSlug: selection.idOrSlug,
        mountSlug: selection.mountSlug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { mounted, failures };
}

export function formatMountFailuresMessage(input: {
  failures: readonly MountSelectionFailure[];
  partialFailed: (count: number) => string;
  singleFailed: (error: string) => string;
}): string | null {
  if (input.failures.length === 0) {
    return null;
  }
  if (input.failures.length === 1) {
    return input.singleFailed(input.failures[0]!.error);
  }
  return input.partialFailed(input.failures.length);
}
