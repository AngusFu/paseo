import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { findAutoAcceptToggleFeature } from "@/composer/acp-auto-approve-toggle";

interface UseComposerAutoAcceptInput {
  serverId: string;
  agentId?: string;
  draftFeatures?: AgentFeature[];
  draftOnSetFeature?: (featureId: string, value: unknown) => void;
}

export function useComposerAutoAccept({
  serverId,
  agentId,
  draftFeatures,
  draftOnSetFeature,
}: UseComposerAutoAcceptInput): {
  feature: ReturnType<typeof findAutoAcceptToggleFeature>;
  disabled: boolean;
  toggle: () => void;
} {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const { updatePreferences } = useFormPreferences();
  const liveAgent = useSessionStore(
    useShallow((state) => {
      if (!agentId) {
        return null;
      }
      const agent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
      if (!agent) {
        return null;
      }
      return { provider: agent.provider, features: agent.features };
    }),
  );

  const feature = useMemo(
    () => findAutoAcceptToggleFeature(draftFeatures ?? liveAgent?.features),
    [draftFeatures, liveAgent?.features],
  );

  const toggle = useCallback(() => {
    if (!feature) {
      return;
    }
    const nextValue = !feature.value;
    if (draftOnSetFeature) {
      draftOnSetFeature("auto_accept", nextValue);
      return;
    }
    if (!client || !agentId || !liveAgent?.provider) {
      return;
    }
    void updatePreferences((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: liveAgent.provider,
        updates: {
          featureValues: {
            auto_accept: nextValue,
          },
        },
      }),
    ).catch((error) => {
      console.warn("[useComposerAutoAccept] persist feature preference failed", error);
    });
    void client.setAgentFeature(agentId, "auto_accept", nextValue).catch((error) => {
      console.warn("[useComposerAutoAccept] setAgentFeature failed", error);
      toast.error(toErrorMessage(error));
    });
  }, [agentId, client, draftOnSetFeature, feature, liveAgent?.provider, toast, updatePreferences]);

  return {
    feature,
    disabled: !client || (!draftOnSetFeature && !agentId),
    toggle,
  };
}
