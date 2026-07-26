import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { mergeGlobalAcpAutoApprove, useFormPreferences } from "@/hooks/use-form-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import {
  ACP_AUTO_ACCEPT_FEATURE_ID,
  readGlobalAcpAutoApprove,
  resolveComposerAutoAcceptFeature,
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
  feature: (AgentFeature & { type: "toggle" }) | null;
  disabled: boolean;
  toggle: () => void;
} {
  const client = useHostRuntimeClient(serverId);
  const { config } = useDaemonConfig(serverId);
  const toast = useToast();
  const { preferences, updatePreferences } = useFormPreferences();
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
  const globalAutoApprove = useMemo(() => readGlobalAcpAutoApprove(preferences), [preferences]);

  const resolvedFeature = useMemo(
    () =>
      resolveComposerAutoAcceptFeature(
        draftFeatures && draftFeatures.length > 0 ? draftFeatures : undefined,
        liveAgent?.features,
      ),
    [draftFeatures, liveAgent?.features],
  );

  const showComposerToggle = shouldShowComposerAcpAutoAccept({
    provider: effectiveProvider,
    config,
    feature: resolvedFeature,
  });

  const settledValue = useMemo(() => {
    if (!resolvedFeature) {
      return undefined;
    }
    if (optimisticValue !== null) {
      return optimisticValue;
    }
    return globalAutoApprove ?? resolvedFeature.value;
  }, [globalAutoApprove, optimisticValue, resolvedFeature]);

  useEffect(() => {
    if (optimisticValue === null || settledValue === undefined) {
      return;
    }
    if (settledValue === optimisticValue) {
      setOptimisticValue(null);
    }
  }, [optimisticValue, settledValue]);

  useEffect(() => {
    if (draftOnSetFeature || !client || !agentId || !resolvedFeature) {
      return;
    }
    if (globalAutoApprove === undefined || globalAutoApprove === resolvedFeature.value) {
      return;
    }
    void client
      .setAgentFeature(agentId, ACP_AUTO_ACCEPT_FEATURE_ID, globalAutoApprove)
      .catch((error) => {
        console.warn("[useComposerAutoAccept] sync global auto_accept failed", error);
      });
  }, [agentId, client, draftOnSetFeature, globalAutoApprove, resolvedFeature]);

  const feature = useMemo(() => {
    if (!showComposerToggle || !resolvedFeature || settledValue === undefined) {
      return null;
    }
    return { ...resolvedFeature, value: settledValue };
  }, [resolvedFeature, settledValue, showComposerToggle]);

  const toggle = useCallback(() => {
    if (!feature) {
      return;
    }
    const nextValue = !feature.value;
    setOptimisticValue(nextValue);
    void updatePreferences((current) => mergeGlobalAcpAutoApprove(current, nextValue)).catch(
      (error) => {
        console.warn("[useComposerAutoAccept] persist global auto_accept failed", error);
      },
    );
    if (draftOnSetFeature) {
      draftOnSetFeature(ACP_AUTO_ACCEPT_FEATURE_ID, nextValue);
      return;
    }
    if (!client || !agentId) {
      return;
    }
    void client.setAgentFeature(agentId, ACP_AUTO_ACCEPT_FEATURE_ID, nextValue).catch((error) => {
      setOptimisticValue(null);
      console.warn("[useComposerAutoAccept] setAgentFeature failed", error);
      toast.error(toErrorMessage(error));
    });
  }, [agentId, client, draftOnSetFeature, feature, toast, updatePreferences]);

  return {
    feature,
    disabled: !client || (!draftOnSetFeature && !agentId),
    toggle,
  };
}
