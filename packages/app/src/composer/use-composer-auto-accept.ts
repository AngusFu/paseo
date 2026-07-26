import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { findAutoAcceptToggleFeature } from "@/composer/acp-auto-approve-toggle";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  shouldShowComposerAcpAutoAccept,
} from "@/composer/acp-auto-approve";

interface UseComposerAutoAcceptInput {
  serverId: string;
  provider?: AgentProvider | null;
  agentId?: string;
  draftFeatures?: AgentFeature[];
  draftOnSetFeature?: (featureId: string, value: unknown) => void;
}

export function useComposerAutoAccept({
  serverId,
  provider,
  agentId,
  draftFeatures,
  draftOnSetFeature,
}: UseComposerAutoAcceptInput): {
  feature: ReturnType<typeof findAutoAcceptToggleFeature>;
  disabled: boolean;
  toggle: () => void;
} {
  const client = useHostRuntimeClient(serverId);
  const { config } = useDaemonConfig(serverId);
  const toast = useToast();
  const { updatePreferences } = useFormPreferences();
  const [optimisticValue, setOptimisticValue] = useState<boolean | null>(null);
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

  const effectiveProvider = provider ?? liveAgent?.provider ?? null;

  const resolvedFeature = useMemo(
    () => findAutoAcceptToggleFeature(draftFeatures ?? liveAgent?.features),
    [draftFeatures, liveAgent?.features],
  );

  const showComposerToggle = shouldShowComposerAcpAutoAccept({
    provider: effectiveProvider,
    config,
    feature: resolvedFeature,
  });

  useEffect(() => {
    if (optimisticValue === null || !resolvedFeature) {
      return;
    }
    if (resolvedFeature.value === optimisticValue) {
      setOptimisticValue(null);
    }
  }, [optimisticValue, resolvedFeature]);

  const feature = useMemo(() => {
    if (!showComposerToggle || !resolvedFeature) {
      return null;
    }
    if (optimisticValue === null) {
      return resolvedFeature;
    }
    return { ...resolvedFeature, value: optimisticValue };
  }, [optimisticValue, resolvedFeature, showComposerToggle]);

  const toggle = useCallback(() => {
    if (!feature) {
      return;
    }
    const nextValue = !feature.value;
    setOptimisticValue(nextValue);
    if (draftOnSetFeature) {
      draftOnSetFeature(ACP_AUTO_ACCEPT_FEATURE_ID, nextValue);
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
            [ACP_AUTO_ACCEPT_FEATURE_ID]: nextValue,
          },
        },
      }),
    ).catch((error) => {
      console.warn("[useComposerAutoAccept] persist feature preference failed", error);
    });
    void client.setAgentFeature(agentId, ACP_AUTO_ACCEPT_FEATURE_ID, nextValue).catch((error) => {
      setOptimisticValue(null);
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
