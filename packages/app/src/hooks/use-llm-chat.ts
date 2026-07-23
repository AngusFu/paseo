import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LlmAssistantKind,
  LlmChatMessage,
  LlmChatToolLink,
} from "@getpaseo/protocol/llm/chat-rpc-schemas";
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
  assistant: LlmAssistantKind;
  selectAssistant: (assistant: LlmAssistantKind) => void;
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
  const [assistant, setAssistant] = useState<LlmAssistantKind>("paseo");
  // Keyed by assistant so switching tabs doesn't discard the other's replies.
  const [messagesByAssistant, setMessagesByAssistant] = useState<
    Partial<Record<LlmAssistantKind, LlmChatMessage[]>>
  >({});
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [toolEvents, setToolEvents] = useState<LlmChatToolEvent[]>([]);
  const [pendingProposal, setPendingProposal] = useState<LlmChatPendingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // The daemon chat backing each assistant, created on its first send. Held in
  // a ref, not state: nothing renders it, and it must survive tab switches
  // without re-running the send effect.
  const chatIdsRef = useRef<Partial<Record<LlmAssistantKind, string>>>({});
  const assistantRef = useRef<LlmAssistantKind>(assistant);
  assistantRef.current = assistant;
  const messages = messagesByAssistant[assistant] ?? EMPTY_MESSAGES;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const appendMessage = useCallback((target: LlmAssistantKind, message: LlmChatMessage) => {
    setMessagesByAssistant((current) => ({
      ...current,
      [target]: [...(current[target] ?? []), message],
    }));
  }, []);

  // Switching away mid-reply would leave the stream writing into a tab the user
  // can no longer see, so the in-flight send is cancelled first.
  const selectAssistant = useCallback(
    (next: LlmAssistantKind) => {
      setError(null);
      setAssistant((current) => {
        if (current !== next && isSending) {
          const chatId = chatIdsRef.current[current];
          if (client && chatId) {
            void client.llmChatCancel(chatId).catch(() => undefined);
          }
        }
        return next;
      });
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
      const chatId = chatIdsRef.current[target] ?? null;
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
      appendMessage(target, localUserMessage);
      try {
        const payload = await client.llmChatSend({
          chatId,
          text: trimmed,
          assistant: target,
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
        chatIdsRef.current[target] = payload.chatId;
        if (payload.message) {
          appendMessage(target, payload.message);
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
    const chatId = chatIdsRef.current[assistantRef.current];
    if (!client || !chatId) {
      return;
    }
    void client.llmChatCancel(chatId).catch(() => undefined);
  }, [client]);

  const clearConversation = useCallback(() => {
    const target = assistantRef.current;
    const chatId = chatIdsRef.current[target];
    chatIdsRef.current[target] = undefined;
    setMessagesByAssistant((current) => ({ ...current, [target]: [] }));
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
