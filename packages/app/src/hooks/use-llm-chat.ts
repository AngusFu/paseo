import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmChatMessage, LlmChatToolLink } from "@getpaseo/protocol/llm/chat-rpc-schemas";
import { useAssistantStore, type LocalAssistant } from "@/stores/assistant-store";
import { useLocalLlmModel, type UseLocalLlmModelResult } from "@/hooks/use-local-llm-model";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const EMPTY_MESSAGES: LlmChatMessage[] = [];

export interface LlmChatToolEvent {
  name: string;
  // undefined while the tool is still running.
  ok?: boolean;
  link?: LlmChatToolLink;
}

// A mutating tool waiting for the user's go-ahead (tool_proposal event).
export interface LlmChatPendingProposal {
  chatId: string;
  proposalId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UseLlmChatResult {
  // false when the daemon lacks the llmChat capability — hide the UI entirely.
  supported: boolean;
  model: UseLocalLlmModelResult["model"];
  startDownload: () => void;
  assistants: LocalAssistant[];
  assistant: LocalAssistant | null;
  selectAssistant: (assistantId: string) => void;
  messages: LlmChatMessage[];
  isSending: boolean;
  // Accumulated streamed reply for the in-flight send; null when idle.
  streamingText: string | null;
  toolEvents: LlmChatToolEvent[];
  pendingProposal: LlmChatPendingProposal | null;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  respondToProposal: (approve: boolean) => void;
  cancel: () => void;
  // Drops the current assistant's conversation, on screen and on the daemon.
  clearConversation: () => void;
}

// Drives the built-in assistant screen: one conversation per assistant kind
// against the daemon's on-device model over the llm.chat.* RPCs, with streamed
// reply chunks and tool activity surfaced while a send is in flight.
//
// Conversations are deliberately not restored across visits. Each assistant is
// a scratchpad — ask, read, move on — so the screen has no chat list and no
// history to manage, just a Clear button. Switching assistants keeps whatever
// each one has said so far for as long as the screen stays mounted.
export function useLlmChat(serverId: string | null | undefined): UseLlmChatResult {
  const supported = useHostFeature(serverId, "llmChat");
  const { model, startDownload } = useLocalLlmModel(serverId);
  const client = useHostRuntimeClient(serverId ?? "");
  const assistants = useAssistantStore((state) => state.assistants);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  // Keyed by assistant id so switching tabs doesn't discard the other's replies.
  const [messagesByAssistant, setMessagesByAssistant] = useState<Record<string, LlmChatMessage[]>>(
    {},
  );
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [toolEvents, setToolEvents] = useState<LlmChatToolEvent[]>([]);
  const [pendingProposal, setPendingProposal] = useState<LlmChatPendingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // The daemon chat backing each assistant, created on its first send. Held in
  // a ref, not state: nothing renders it, and it must survive tab switches
  // without re-running the send effect.
  const chatIdsRef = useRef<Record<string, string | undefined>>({});
  // Falls back to the first tab so a deleted assistant never leaves the screen
  // pointing at nothing.
  const assistant = assistants.find((entry) => entry.id === assistantId) ?? assistants[0] ?? null;
  const assistantRef = useRef<LocalAssistant | null>(assistant);
  assistantRef.current = assistant;
  const messages = assistant
    ? (messagesByAssistant[assistant.id] ?? EMPTY_MESSAGES)
    : EMPTY_MESSAGES;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const appendMessage = useCallback((targetId: string, message: LlmChatMessage) => {
    setMessagesByAssistant((current) => ({
      ...current,
      [targetId]: [...(current[targetId] ?? []), message],
    }));
  }, []);

  // Switching away mid-reply would leave the stream writing into a tab the user
  // can no longer see, so the in-flight send is cancelled first.
  const selectAssistant = useCallback(
    (nextId: string) => {
      setError(null);
      const current = assistantRef.current;
      if (current && current.id !== nextId && isSending) {
        const chatId = chatIdsRef.current[current.id];
        if (client && chatId) {
          void client.llmChatCancel(chatId).catch(() => undefined);
        }
      }
      setAssistantId(nextId);
    },
    [client, isSending],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!client || !trimmed || isSending) {
        return;
      }
      const target = assistantRef.current;
      if (!target) {
        return;
      }
      const chatId = chatIdsRef.current[target.id] ?? null;
      setIsSending(true);
      setError(null);
      setStreamingText(null);
      setToolEvents([]);
      const localUserMessage: LlmChatMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      appendMessage(target.id, localUserMessage);
      try {
        const payload = await client.llmChatSend({
          chatId,
          text: trimmed,
          systemPrompt: target.systemPrompt,
          tools: target.tools,
          onEvent: (event) => {
            if (!mountedRef.current) {
              return;
            }
            switch (event.event.kind) {
              case "chunk": {
                const chunk = event.event.text;
                setStreamingText((current) => (current ?? "") + chunk);
                break;
              }
              case "tool_proposal": {
                const { proposalId, name, input } = event.event;
                setPendingProposal({ chatId: event.chatId, proposalId, name, input });
                break;
              }
              case "tool_call": {
                const name = event.event.name;
                setPendingProposal(null);
                setToolEvents((current) => [...current, { name }]);
                break;
              }
              case "tool_result": {
                const { name, ok, link } = event.event;
                setPendingProposal(null);
                setToolEvents((current) => {
                  const next = [...current];
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].name === name && next[i].ok === undefined) {
                      next[i] = { name, ok, link };
                      return next;
                    }
                  }
                  // A declined proposal has no matching tool_call entry.
                  next.push({ name, ok, link });
                  return next;
                });
                break;
              }
              default:
                break;
            }
          },
        });
        if (!mountedRef.current) {
          return;
        }
        chatIdsRef.current[target.id] = payload.chatId;
        if (payload.message) {
          appendMessage(target.id, payload.message);
        }
        if (payload.error) {
          setError(payload.error);
        }
      } catch (sendError) {
        if (mountedRef.current) {
          setError(sendError instanceof Error ? sendError.message : String(sendError));
        }
      } finally {
        if (mountedRef.current) {
          setIsSending(false);
          setStreamingText(null);
          setToolEvents([]);
          setPendingProposal(null);
        }
      }
    },
    [appendMessage, client, isSending],
  );

  const respondToProposal = useCallback(
    (approve: boolean) => {
      const proposal = pendingProposal;
      if (!client || !proposal) {
        return;
      }
      // Optimistically dismiss the card; the daemon's tool_call/tool_result
      // events carry the authoritative outcome.
      setPendingProposal(null);
      void client
        .llmChatToolRespond({
          chatId: proposal.chatId,
          proposalId: proposal.proposalId,
          approve,
        })
        .catch(() => undefined);
    },
    [client, pendingProposal],
  );

  const cancel = useCallback(() => {
    const active = assistantRef.current;
    const chatId = active ? chatIdsRef.current[active.id] : undefined;
    if (!client || !chatId) {
      return;
    }
    void client.llmChatCancel(chatId).catch(() => undefined);
  }, [client]);

  const clearConversation = useCallback(() => {
    const target = assistantRef.current;
    if (!target) {
      return;
    }
    const chatId = chatIdsRef.current[target.id];
    chatIdsRef.current[target.id] = undefined;
    setMessagesByAssistant((current) => ({ ...current, [target.id]: [] }));
    setError(null);
    if (client && chatId) {
      // Best effort: the screen has already forgotten the chat either way, so
      // a failed delete would only leave a file the user never sees again.
      void client.llmChatDelete(chatId).catch(() => undefined);
    }
  }, [client]);

  return {
    supported: supported && client !== null,
    model,
    startDownload,
    assistants,
    assistant,
    selectAssistant,
    messages,
    isSending,
    streamingText,
    toolEvents,
    pendingProposal,
    error,
    sendMessage,
    respondToProposal,
    cancel,
    clearConversation,
  };
}
