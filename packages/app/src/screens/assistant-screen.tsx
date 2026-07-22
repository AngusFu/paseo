// oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-object-as-prop, react/no-array-index-key
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ArrowUp, Bot, Plus, Square, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { LlmChatMessage, LlmChatSummary } from "@getpaseo/protocol/llm/chat-rpc-schemas";
import { MenuHeader } from "@/components/headers/menu-header";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  useLlmChat,
  type LlmChatPendingProposal,
  type LlmChatToolEvent,
} from "@/hooks/use-llm-chat";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { router } from "expo-router";
import type { LlmChatToolLink } from "@getpaseo/protocol/llm/chat-rpc-schemas";
import { buildKanbanRoute, buildSchedulesRoute, buildWorkflowsRoute } from "@/utils/host-routes";

export function AssistantScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <AssistantScreenContent />;
}

function AssistantScreenContent(): ReactElement {
  const { t } = useTranslation();
  // Single active host, same scoping the kanban board uses.
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (connectionStatuses.get(serverId) ?? "connecting") : null;
  const isOnline = connectionStatus === "online";
  const chat = useLlmChat(serverId);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("assistant.title")} />
      <AssistantBody serverId={serverId} isOnline={isOnline} chat={chat} />
    </View>
  );
}

interface AssistantBodyProps {
  serverId: string | null;
  isOnline: boolean;
  chat: ReturnType<typeof useLlmChat>;
}

function AssistantBody({ serverId, isOnline, chat }: AssistantBodyProps): ReactElement {
  const { t } = useTranslation();

  if (serverId && isOnline && !chat.supported) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message} testID="assistant-unsupported">
          {t("assistant.unsupported")}
        </Text>
      </View>
    );
  }

  if (!serverId || !isOnline) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (chat.model?.status !== "ready") {
    return <ModelGate chat={chat} />;
  }

  return <ChatView chat={chat} />;
}

function ModelGate({ chat }: { chat: ReturnType<typeof useLlmChat> }): ReactElement {
  const { t } = useTranslation();
  const model = chat.model;

  if (model?.status === "downloading") {
    const percent =
      model.totalBytes && model.totalBytes > 0
        ? Math.round((model.receivedBytes / model.totalBytes) * 100)
        : 0;
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
        <Text style={styles.message}>{t("assistant.model.downloading", { percent })}</Text>
      </View>
    );
  }

  if (model?.status === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("assistant.model.error", { message: model.message })}</Text>
        <Button variant="outline" onPress={chat.startDownload} testID="assistant-model-retry">
          {t("assistant.model.download")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.centered}>
      <Bot size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <Text style={styles.message}>{t("assistant.model.required")}</Text>
      <Button variant="outline" onPress={chat.startDownload} testID="assistant-model-download">
        {t("assistant.model.download")}
      </Button>
    </View>
  );
}

function ChatView({ chat }: { chat: ReturnType<typeof useLlmChat> }): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    scrollToEnd();
  }, [chat.messages.length, chat.streamingText, scrollToEnd]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || chat.isSending) {
      return;
    }
    setDraft("");
    void chat.sendMessage(text);
  }, [draft, chat]);

  // Web multiline inputs never fire onSubmitEditing; Enter sends, Shift+Enter
  // inserts a newline, and an IME confirming a candidate never sends.
  const handleKeyPress = useCallback(
    (event: {
      preventDefault?: () => void;
      nativeEvent: { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
    }) => {
      if (event.nativeEvent.key !== "Enter" || event.nativeEvent.shiftKey) {
        return;
      }
      if (isImeComposingKeyboardEvent(event.nativeEvent)) {
        return;
      }
      event.preventDefault?.();
      handleSend();
    },
    [handleSend],
  );

  return (
    <View style={styles.body}>
      <ChatTabs chat={chat} />
      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        onContentSizeChange={scrollToEnd}
      >
        {chat.messages.length === 0 && !chat.isSending ? (
          <View style={styles.emptyState} testID="assistant-empty">
            <Bot size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
            <Text style={styles.message}>{t("assistant.empty")}</Text>
          </View>
        ) : null}
        {chat.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {chat.isSending ? (
          <StreamingBubble
            streamingText={chat.streamingText}
            toolEvents={chat.toolEvents}
            pendingProposal={chat.pendingProposal}
            onRespondToProposal={chat.respondToProposal}
          />
        ) : null}
        {chat.error ? (
          <Text style={styles.errorText} testID="assistant-error">
            {chat.error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.inputArea}>
        <View style={styles.inputShell}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={t("assistant.inputPlaceholder")}
            placeholderTextColor={styles.inputPlaceholder.color}
            multiline
            submitBehavior="submit"
            onSubmitEditing={handleSend}
            onKeyPress={handleKeyPress}
            editable={!chat.isSending}
            testID="assistant-input"
          />
          {chat.isSending ? (
            <Pressable
              style={styles.stopButton}
              onPress={chat.cancel}
              hitSlop={6}
              accessibilityLabel={t("common.actions.cancel")}
              testID="assistant-cancel"
            >
              <Square
                size={styles.stopIcon.width}
                color={styles.stopIcon.color}
                fill={styles.stopIcon.color}
              />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.sendButton, draft.trim().length === 0 && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={draft.trim().length === 0}
              hitSlop={6}
              accessibilityLabel={t("assistant.send")}
              testID="assistant-send"
            >
              <ArrowUp size={styles.sendIcon.width} color={styles.sendIcon.color} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function ChatTabs({ chat }: { chat: ReturnType<typeof useLlmChat> }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.tabsRow}>
      <Button
        variant="outline"
        size="sm"
        leftIcon={Plus}
        onPress={() => chat.selectChat(null)}
        disabled={chat.isSending}
        testID="assistant-new-chat"
      >
        {t("assistant.newChat")}
      </Button>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
        <View style={styles.tabsInner}>
          {chat.chats.map((summary) => (
            <ChatTab
              key={summary.id}
              summary={summary}
              isActive={summary.id === chat.activeChatId}
              disabled={chat.isSending}
              onSelect={() => chat.selectChat(summary.id)}
              onDelete={() => void chat.deleteChat(summary.id)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

interface ChatTabProps {
  summary: LlmChatSummary;
  isActive: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function ChatTab({ summary, isActive, disabled, onSelect, onDelete }: ChatTabProps): ReactElement {
  return (
    <View style={[styles.tab, isActive && styles.tabActive]}>
      <Pressable onPress={onSelect} disabled={disabled} testID={`assistant-chat-${summary.id}`}>
        <Text
          style={[styles.tabLabel, isActive && styles.tabLabelActive]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {summary.title}
        </Text>
      </Pressable>
      {isActive ? (
        <Pressable
          onPress={onDelete}
          disabled={disabled}
          hitSlop={8}
          testID={`assistant-chat-delete-${summary.id}`}
        >
          <Trash2 size={styles.tabDeleteIcon.width} color={styles.tabDeleteIcon.color} />
        </Pressable>
      ) : null}
    </View>
  );
}

function MessageBubble({ message }: { message: LlmChatMessage }): ReactElement {
  if (message.role === "user") {
    return (
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{message.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistantBubble}>
      {message.toolCalls?.map((call, index) => (
        <ToolEventLine
          key={`${message.id}-tool-${index}`}
          event={{ name: call.name, ok: call.ok, link: call.link }}
        />
      ))}
      <MarkdownRenderer text={message.text} compact />
    </View>
  );
}

function StreamingBubble({
  streamingText,
  toolEvents,
  pendingProposal,
  onRespondToProposal,
}: {
  streamingText: string | null;
  toolEvents: LlmChatToolEvent[];
  pendingProposal: LlmChatPendingProposal | null;
  onRespondToProposal: (approve: boolean) => void;
}): ReactElement {
  return (
    <View style={styles.assistantBubble} testID="assistant-streaming">
      {toolEvents.map((event, index) => (
        <ToolEventLine key={`stream-tool-${index}`} event={event} />
      ))}
      {pendingProposal ? (
        <ProposalCard proposal={pendingProposal} onRespond={onRespondToProposal} />
      ) : null}
      {streamingText ? <MarkdownRenderer text={streamingText} compact /> : null}
      {!streamingText && !pendingProposal ? (
        <LoadingSpinner size="small" color={styles.spinner.color} />
      ) : null}
    </View>
  );
}

// AG-UI style confirmation: the daemon parks the tool call until the user
// answers this card (or the proposal times out server-side).
function ProposalCard({
  proposal,
  onRespond,
}: {
  proposal: LlmChatPendingProposal;
  onRespond: (approve: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.proposalCard} testID="assistant-proposal">
      <Text style={styles.proposalTitle}>
        {t("assistant.proposal.title", { name: proposal.name })}
      </Text>
      <Text style={styles.proposalInput} numberOfLines={6}>
        {JSON.stringify(proposal.input, null, 2)}
      </Text>
      <View style={styles.proposalActions}>
        <Button
          variant="default"
          size="sm"
          onPress={() => onRespond(true)}
          testID="assistant-proposal-run"
        >
          {t("assistant.proposal.run")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={() => onRespond(false)}
          testID="assistant-proposal-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}

function navigateToToolLink(link: LlmChatToolLink): void {
  switch (link.entity) {
    case "schedule":
      router.push(buildSchedulesRoute());
      break;
    case "workflowRun":
      router.push(buildWorkflowsRoute());
      break;
    case "kanbanCard":
      router.push(buildKanbanRoute());
      break;
  }
}

function ToolEventLine({ event }: { event: LlmChatToolEvent }): ReactElement {
  const { t } = useTranslation();
  let label: string;
  if (event.ok === undefined) {
    label = t("assistant.tool.running", { name: event.name });
  } else if (event.ok) {
    label = t("assistant.tool.done", { name: event.name });
  } else {
    label = t("assistant.tool.failed", { name: event.name });
  }
  const link = event.link;
  if (link) {
    return (
      <Pressable onPress={() => navigateToToolLink(link)} testID="assistant-tool-link">
        <Text style={styles.toolLine}>
          {label}
          <Text style={styles.toolLinkSuffix}> {t("assistant.tool.view")} →</Text>
        </Text>
      </Pressable>
    );
  }
  return <Text style={styles.toolLine}>{label}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  // Static color holder read by the spinner (no useUnistyles in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[8],
  },
  tabsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  tabsScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  tabsInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    maxWidth: 220,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabDeleteIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.sm,
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 860,
    width: "100%",
    alignSelf: "center",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    maxWidth: "85%",
  },
  userText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    maxWidth: "95%",
    gap: theme.spacing[1],
  },
  toolLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
  toolLinkSuffix: {
    color: theme.colors.foreground,
    fontStyle: "normal",
  },
  proposalCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    maxWidth: 480,
  },
  proposalTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  proposalInput: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  proposalActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  inputArea: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  inputShell: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1.5],
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1.5],
    // Kill the web focus ring; the shell border is the affordance.
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  inputPlaceholder: {
    color: theme.colors.foregroundMuted,
  },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendIcon: {
    width: theme.iconSize.sm,
    color: theme.colors.accentForeground,
  },
  stopButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  stopIcon: {
    width: theme.iconSize.xs,
    color: theme.colors.foreground,
  },
}));
