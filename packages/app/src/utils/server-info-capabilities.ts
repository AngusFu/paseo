import type { ServerCapabilityState, ServerDiffToolsCapability } from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";

export type VoiceReadinessMode = "dictation" | "voice";

// COMPAT(diffTools): older servers (pre v0.1.107) never send `capabilities.diffTools` at all —
// callers must treat an absent capability as "no non-git engines", not as "difftastic
// unavailable" (that would still show a disabled difftastic entry the old server can't honor).
export function getDiffToolsCapability(params: {
  serverInfo: DaemonServerInfo | null | undefined;
}): ServerDiffToolsCapability | null {
  const capabilities = getServerCapabilities({ serverInfo: params.serverInfo });
  return capabilities?.diffTools ?? null;
}

export function getServerCapabilities(params: {
  serverInfo: DaemonServerInfo | null | undefined;
}): DaemonServerInfo["capabilities"] | null {
  const capabilities = params.serverInfo?.capabilities;
  if (!capabilities) {
    return null;
  }
  return capabilities;
}

export function getVoiceReadinessState(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): ServerCapabilityState | null {
  const capabilities = getServerCapabilities({ serverInfo: params.serverInfo });
  const voice = capabilities?.voice;
  if (!voice) {
    return null;
  }
  if (params.mode === "dictation") {
    return voice.dictation;
  }
  return voice.voice;
}

export function resolveVoiceUnavailableMessage(params: {
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): string | null {
  const readiness = getVoiceReadinessState({
    serverInfo: params.serverInfo,
    mode: params.mode,
  });
  if (!readiness) {
    return null;
  }
  if (readiness.enabled && readiness.reason.trim().length === 0) {
    return null;
  }
  const message = readiness.reason.trim();
  if (message.length > 0) {
    return message;
  }
  return null;
}
