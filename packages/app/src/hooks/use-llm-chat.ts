import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LlmChatMessage,
  LlmChatSummary,
  LlmChatToolLink,
} from "@getpaseo/protocol/llm/chat-rpc-schemas";
import { useLocalLlmModel, type UseLocalLlmModelResult } from "@/hooks/use-local-llm-model";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

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
  chats: LlmChatSummary[];
  activeChatId: string | null;
  messages: LlmChatMessage[];
  isLoadingChat: boolean;
  isSending: boolean;
  // Accumulated streamed reply for the in-flight send; null when idle.
  streamingText: string | null;
  toolEvents: LlmChatToolEvent[];
  pendingProposal: LlmChatPendingProposal | null;
  error: string | null;
  selectChat: (chatId: string | null) => void;
  sendMessage: (text: string) => Promise<void>;
  respondToProposal: (approve: boolean) => void;
  cancel: () => void;
  deleteChat: (chatId: string) => Promise<void>;
}

// Drives the built-in assistant screen: multi-turn chats with the daemon's
// on-device model over the llm.chat.* RPCs, with streamed reply chunks and
// tool activity surfaced while a send is in flight.
export function useLlmChat(serverId: string | null | undefined): UseLlmChatResult {
  const supported = useHostFeature(serverId, "llmChat");
  const { model, startDownload } = useLocalLlmModel(serverId);
  const client = useHostRuntimeClient(serverId ?? "");
  const [chats, setChats] = useState<LlmChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LlmChatMessage[]>([]);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [toolEvents, setToolEvents] = useState<LlmChatToolEvent[]>([]);
  const [pendingProposal, setPendingProposal] = useState<LlmChatPendingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshChats = useCallback(async () => {
    if (!client) {
      return;
    }
    try {
      const payload = await client.llmChatList();
      if (mountedRef.current) {
        setChats(payload.chats);
      }
    } catch {
      // The list is cosmetic; leave the last known state in place.
    }
  }, [client]);

  useEffect(() => {
    if (!supported || !client) {
      return;
    }
    void refreshChats();
  }, [supported, client, refreshChats]);

  const selectChat = useCallback(
    (chatId: string | null) => {
      setActiveChatId(chatId);
      setError(null);
      if (!chatId) {
        setMessages([]);
        return;
      }
      if (!client) {
        return;
      }
      setIsLoadingChat(true);
      void (async () => {
        try {
          const payload = await client.llmChatGet(chatId);
          if (mountedRef.current && activeChatIdRef.current === chatId) {
            setMessages(payload.chat?.messages ?? []);
          }
        } catch {
          // Keep whatever is on screen; the next send re-syncs from disk.
        } finally {
          if (mountedRef.current) {
            setIsLoadingChat(false);
          }
        }
      })();
    },
    [client],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!client || !trimmed || isSending) {
        return;
      }
      const chatId = activeChatIdRef.current;
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
      setMessages((current) => [...current, localUserMessage]);
      try {
        const payload = await client.llmChatSend({
          chatId,
          text: trimmed,
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
        setActiveChatId(payload.chatId);
        if (payload.message) {
          const message = payload.message;
          setMessages((current) => [...current, message]);
        }
        if (payload.error) {
          setError(payload.error);
        }
        void refreshChats();
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
    [client, isSending, refreshChats],
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
    const chatId = activeChatIdRef.current;
    if (!client || !chatId) {
      return;
    }
    void client.llmChatCancel(chatId).catch(() => undefined);
  }, [client]);

  const deleteChat = useCallback(
    async (chatId: string) => {
      if (!client) {
        return;
      }
      try {
        await client.llmChatDelete(chatId);
      } catch {
        // Deletion failures leave the entry; the next refresh re-syncs.
      }
      if (mountedRef.current) {
        if (activeChatIdRef.current === chatId) {
          setActiveChatId(null);
          setMessages([]);
        }
        void refreshChats();
      }
    },
    [client, refreshChats],
  );

  return {
    supported: supported && client !== null,
    model,
    startDownload,
    chats,
    activeChatId,
    messages,
    isLoadingChat,
    isSending,
    streamingText,
    toolEvents,
    pendingProposal,
    error,
    selectChat,
    sendMessage,
    respondToProposal,
    cancel,
    deleteChat,
  };
}
