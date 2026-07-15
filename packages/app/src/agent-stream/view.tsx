import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  Pressable,
  Platform,
  ActivityIndicator,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { useMutation } from "@tanstack/react-query";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react-native";
import { usePanelStore } from "@/stores/panel-store";
import {
  AssistantMessage,
  SpeakMessage,
  UserMessage,
  ActivityLog,
  ToolCall,
  TodoListCard,
  ToolRunSummary,
  CompactionMarker,
  MessageOuterSpacingProvider,
  type CollapseSignal,
  type InlinePathTarget,
} from "@/components/message";
import { PlanCard } from "@/components/plan-card";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import type {
  AgentCapabilityFlags,
  AgentPermissionAction,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useSessionStore } from "@/stores/session-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { useSettings, TRANSCRIPT_ZOOM_LEVELS, DEFAULT_TRANSCRIPT_ZOOM } from "@/hooks/use-settings";
import type { ToastApi } from "@/components/toast-host";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import { QuestionFormCard } from "@/components/question-form-card";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import { OverviewToolCallGroupView } from "@/tool-calls/detail-level/overview/view";
import { type AgentStreamRenderModel, buildAgentStreamRenderModel } from "./model";
import { TranscriptZoomLayer } from "./transcript-zoom-layer";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { type StreamSegmentRenderers, type StreamViewportHandle } from "./strategy";
import {
  CompletedTurnFooterRow,
  TurnFooter,
  type AssistantTurnForkHandler,
  type TurnContentStrategy,
} from "./turn-footer";
import { layoutStream, type StreamLayoutItem } from "./layout";
import {
  type BottomAnchorLocalRequest,
  type BottomAnchorRouteRequest,
} from "./bottom-anchor-controller";
import {
  AssistantFileLinkResolverProvider,
  normalizeInlinePathTarget,
} from "@/assistant-file-links";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type OpenFileDisposition,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { recordRenderProfileReasons } from "@/utils/render-profiler";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { generateDraftId } from "@/stores/draft-keys";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { toErrorMessage } from "@/utils/error-messages";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

function renderLiveAuxiliaryNode(input: {
  pendingPermissions: ReactNode;
  turnFooter: ReactNode;
}): ReactNode {
  if (!input.pendingPermissions && !input.turnFooter) {
    return null;
  }
  return (
    <>
      {input.turnFooter}
      {input.pendingPermissions ? (
        <View style={stylesheet.contentWrapper}>
          <View style={stylesheet.listHeaderContent}>{input.pendingPermissions}</View>
        </View>
      ) : null}
    </>
  );
}

function renderPendingPermissionsNode(input: {
  pendingPermissions: PendingPermission[];
  client: DaemonClient | null;
}): ReactNode {
  if (input.pendingPermissions.length === 0) {
    return null;
  }
  return (
    <View style={stylesheet.permissionsContainer}>
      {input.pendingPermissions.map((permission) => (
        <PermissionRequestCard key={permission.key} permission={permission} client={input.client} />
      ))}
    </View>
  );
}

function renderStreamItemWithTurnFooter(input: {
  content: ReactNode;
  layoutItem: StreamLayoutItem;
  strategy: TurnContentStrategy;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}): ReactNode {
  if (!input.content) {
    return null;
  }

  const footerHost = input.layoutItem.completedFooter;
  const footer = footerHost ? (
    <CompletedTurnFooterRow
      strategy={input.strategy}
      items={footerHost.items}
      timing={footerHost.timing}
      startIndex={footerHost.startIndex}
      supportsTimelineCursor={input.supportsTimelineCursor}
      onForkAssistantTurn={input.onForkAssistantTurn}
    />
  ) : null;
  const content = (
    <StreamItemWrapper gapBelow={input.layoutItem.gapBelow}>{input.content}</StreamItemWrapper>
  );

  if (input.layoutItem.frameOrder === "footer-then-content") {
    return (
      <>
        {footer}
        {content}
      </>
    );
  }

  return (
    <>
      {content}
      {footer}
    </>
  );
}

function renderListEmptyComponent(input: {
  renderModel: AgentStreamRenderModel;
  emptyStateStyle: StyleProp<ViewStyle>;
  emptyText: string;
}): ReactNode {
  if (
    input.renderModel.boundary.hasVirtualizedHistory ||
    input.renderModel.boundary.hasMountedHistory ||
    input.renderModel.boundary.hasLiveHead ||
    input.renderModel.auxiliary.pendingPermissions ||
    input.renderModel.auxiliary.turnFooter
  ) {
    return null;
  }

  return (
    <View style={input.emptyStateStyle}>
      <Text style={stylesheet.emptyStateText}>{input.emptyText}</Text>
    </View>
  );
}

function renderHistoryStreamItem(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return input.renderStreamItem(layoutItem);
}

function renderLiveHeadStreamItem(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return input.renderStreamItem(layoutItem);
}

export interface AgentStreamViewHandle {
  scrollToBottom(reason?: BottomAnchorLocalRequest["reason"]): void;
  prepareForViewportChange(): void;
}

export interface AgentStreamViewProps {
  agentId: string;
  serverId?: string;
  context: AgentScreenAgent;
  streamItems: StreamItem[];
  streamHead?: StreamItem[];
  pendingPermissions: Map<string, PendingPermission>;
  routeBottomAnchorRequest?: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady?: boolean;
  toast?: ToastApi | null;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
  readOnly?: boolean;
  historyPagination?: {
    hasOlder: boolean;
    isLoadingOlder: boolean;
    onLoadOlder: () => void;
  };
}

const AGENT_CAPABILITY_FLAG_KEYS: (keyof AgentCapabilityFlags)[] = [
  "supportsStreaming",
  "supportsSessionPersistence",
  "supportsDynamicModes",
  "supportsMcpServers",
  "supportsReasoningStream",
  "supportsToolInvocations",
  "supportsRewindConversation",
  "supportsRewindFiles",
  "supportsRewindBoth",
];

const EMPTY_STREAM_HEAD: StreamItem[] = [];
const GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT = 200;

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function buildForkDraftSetup(agent: AgentScreenAgent): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

const AgentStreamViewComponent = forwardRef<AgentStreamViewHandle, AgentStreamViewProps>(
  function AgentStreamView(
    {
      agentId,
      serverId,
      context,
      streamItems,
      streamHead: providedStreamHead,
      pendingPermissions,
      routeBottomAnchorRequest = null,
      isAuthoritativeHistoryReady = true,
      toast,
      onOpenWorkspaceFile,
      readOnly = false,
      historyPagination,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const router = useRouter();
    const autoExpandReasoning = useSettings((settings) => settings.autoExpandReasoning);
    const toolCallDetailLevel = useSettings((settings) => settings.toolCallDetailLevel);
    const viewportRef = useRef<StreamViewportHandle | null>(null);
    const isMobile = useIsCompactFormFactor();
    const streamRenderStrategy = useMemo(
      () =>
        resolveStreamRenderStrategy({
          platform: Platform.OS,
          isMobileBreakpoint: isMobile,
        }),
      [isMobile],
    );
    const [isNearBottom, setIsNearBottom] = useState(true);
    const [expandedInlineToolCallIds, setExpandedInlineToolCallIds] = useState<Set<string>>(
      new Set(),
    );
    // Stream-wide collapse/expand-all broadcast. Each press bumps the epoch so
    // mounted tool-call / thinking / task cards react (once) and flip to the
    // target expansion; the epoch guard keeps mount respecting per-card defaults.
    const [collapseSignal, setCollapseSignal] = useState<CollapseSignal>({
      epoch: 0,
      expanded: false,
    });
    const handleToggleCollapseAll = useCallback(() => {
      setCollapseSignal((prev) => ({ epoch: prev.epoch + 1, expanded: !prev.expanded }));
    }, []);
    const collapseToggleButtonStyle = useCallback(
      ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
        stylesheet.collapseToggleButton,
        hovered ? stylesheet.collapseToggleButtonHovered : null,
        pressed ? stylesheet.collapseToggleButtonPressed : null,
      ],
      [],
    );
    // Agent-transcript zoom (web-only). A user preference persisted in settings;
    // read here to feed <TranscriptZoomLayer>, which wraps the whole transcript
    // in a `zoom`-scaled DOM layer on web. The stepping controls live in
    // <TranscriptZoomControl>. Native ignores the value.
    const transcriptZoom = useSettings((settings) => settings.transcriptZoom);

    const [expandedToolCallGroupIds, setExpandedToolCallGroupIds] = useState<Set<string>>(
      new Set(),
    );
    const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
    const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);

    // Get serverId (fallback to agent's serverId if not provided)
    const resolvedServerId = resolveServerId(serverId, context.serverId);

    const client = useSessionStore((state) => state.sessions[resolvedServerId]?.client ?? null);
    const sessionStreamHead = useSessionStore((state) =>
      state.sessions[resolvedServerId]?.agentStreamHead?.get(agentId),
    );
    const streamHead = providedStreamHead ?? sessionStreamHead;
    const supportsAgentForkContext = useSessionStore(
      (state) =>
        !readOnly &&
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentForkContext === true,
    );
    const supportsAgentForkContextCursor = useSessionStore(
      (state) =>
        state.sessions[resolvedServerId]?.serverInfo?.features?.agentForkContextCursor === true,
    );

    const workspaceRoot = context.cwd?.trim() || "";
    const { requestDirectoryListing } = useFileExplorerActions({
      serverId: resolvedServerId,
      workspaceId: context.workspaceId,
      workspaceRoot,
    });
    const agentHistoryPagination = useLoadOlderAgentHistory({
      serverId: resolvedServerId,
      agentId,
      toast,
    });
    const { isLoadingOlder, hasOlder, loadOlder } = resolveHistoryPagination(
      historyPagination,
      agentHistoryPagination,
    );
    // Keep entry/exit animations off on Android due to RN dispatchDraw crashes
    // tracked in react-native-reanimated#8422.
    const shouldDisableEntryExitAnimations = Platform.OS === "android";
    const scrollIndicatorFadeIn = shouldDisableEntryExitAnimations
      ? undefined
      : FadeIn.duration(200);
    const scrollIndicatorFadeOut = shouldDisableEntryExitAnimations
      ? undefined
      : FadeOut.duration(200);

    useEffect(() => {
      setIsNearBottom(true);
      setExpandedInlineToolCallIds(new Set());
      setExpandedToolCallGroupIds(new Set());
    }, [agentId]);

    const handleInlinePathPress = useStableEvent(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        if (!target.path) {
          return;
        }

        const normalized = normalizeInlinePathTarget(target.path, context.cwd);
        if (!normalized) {
          return;
        }

        if (normalized.file) {
          const location = normalizeWorkspaceFileLocation({
            path: normalized.file,
            lineStart: target.lineStart,
            lineEnd: target.lineEnd,
          });
          if (!location) {
            return;
          }

          if (onOpenWorkspaceFile) {
            onOpenWorkspaceFile({
              location,
              disposition,
            });
            return;
          }

          if (context.workspaceId) {
            navigateToWorkspace({
              serverId: resolvedServerId,
              workspaceId: context.workspaceId,
              target: createWorkspaceFileTabTarget(location),
            });
          }
          return;
        }

        void requestDirectoryListing(normalized.directory, {
          recordHistory: false,
          setCurrentPath: false,
        });

        const checkout = {
          serverId: resolvedServerId,
          cwd: context.cwd,
          isGit: context.projectPlacement?.checkout?.isGit ?? true,
        };
        setExplorerTabForCheckout({ ...checkout, tab: "files" });
        openFileExplorerForCheckout({
          isCompact: isMobile,
          checkout,
        });
      },
    );

    const handleToolCallOpenFile = useStableEvent((filePath: string) => {
      handleInlinePathPress({ raw: filePath, path: filePath }, "main");
    });

    const handleForkAssistantTurn: AssistantTurnForkHandler = useStableEvent(
      async ({ target, boundary }) => {
        try {
          if (!supportsAgentForkContext) {
            toast?.error(t("message.actions.forkUnavailable"));
            return;
          }
          if (!client) {
            throw new Error(t("workspace.terminal.hostDisconnected"));
          }
          const draftSetup = buildForkDraftSetup(context);
          const prepareForkDraft = async () => {
            const draftId = generateDraftId();
            const payload = await client.buildAgentForkContext(agentId, boundary);
            const attachment = buildChatHistoryAttachment({
              draftId,
              serverId: resolvedServerId,
              agentId,
              payload,
              missingAttachmentMessage: t("message.actions.forkFailed"),
            });
            useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
              scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
              attachments: [attachment],
            });
            return draftId;
          };

          if (target === "tab") {
            const workspaceId = context.workspaceId;
            if (!workspaceId) {
              throw new Error(t("message.actions.forkMissingWorkspace"));
            }
            const draftId = await prepareForkDraft();
            navigateToWorkspace({
              serverId: resolvedServerId,
              workspaceId,
              target: buildForkDraftTabTarget(draftSetup, draftId),
            });
            return;
          }

          const draftId = await prepareForkDraft();
          const sourceDirectory =
            context.projectPlacement?.checkout?.cwd?.trim() || context.cwd.trim() || undefined;
          if (draftSetup) {
            useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
              draftId,
              setup: draftSetup,
              sourceDirectory,
            });
          }
          router.push(
            buildNewWorkspaceRoute({
              serverId: resolvedServerId,
              sourceDirectory,
              displayName: context.projectPlacement?.projectName,
              projectId: context.projectPlacement?.projectKey,
              draftId,
            }),
          );
        } catch (error) {
          toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
        }
      },
    );

    // Freeze stream data while this tab slot is hidden to prevent offscreen FlatList
    // cell-window renders on every 48ms flush from background agents.
    // When isActive flips back to true, the context change triggers a re-render and
    // the component reads the current (fresh) streamItems/streamHead from props.
    const isActive = useRetainedPanelActive();
    const frozenStreamItemsRef = useRef(streamItems);
    const frozenStreamHeadRef = useRef(streamHead);
    if (isActive) {
      frozenStreamItemsRef.current = streamItems;
      frozenStreamHeadRef.current = streamHead;
    }
    const effectiveStreamItems = isActive ? streamItems : frozenStreamItemsRef.current;
    const effectiveStreamHead = isActive ? streamHead : frozenStreamHeadRef.current;
    // Keep retained history outside the 48ms live-head flush path.
    const preparedToolCallHistory = useMemo(
      () => prepareToolCallHistory(toolCallDetailLevel, effectiveStreamItems),
      [effectiveStreamItems, toolCallDetailLevel],
    );
    const projectedToolCalls = useMemo(
      () =>
        projectToolCallDetailLevel({
          level: toolCallDetailLevel,
          tail: effectiveStreamItems,
          head: effectiveStreamHead ?? EMPTY_STREAM_HEAD,
          preparedHistory: preparedToolCallHistory,
          isTurnActive: context.status === "running",
        }),
      [
        context.status,
        effectiveStreamHead,
        effectiveStreamItems,
        preparedToolCallHistory,
        toolCallDetailLevel,
      ],
    );

    const baseRenderModel = useMemo(() => {
      return buildAgentStreamRenderModel({
        agentStatus: context.status,
        tail: projectedToolCalls.tail,
        head: projectedToolCalls.head,
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
      });
    }, [context.status, isMobile, projectedToolCalls.head, projectedToolCalls.tail]);
    const streamLayout = useMemo(
      () =>
        layoutStream({
          strategy: streamRenderStrategy,
          agentStatus: context.status,
          history: baseRenderModel.history,
          liveHead: baseRenderModel.segments.liveHead,
          timingByAssistantId: baseRenderModel.turnTiming.byAssistantId,
          // In compact detail levels, ToolCallGroup owns the grouping; keep our
          // layout-level ToolRunSummary grouping only for the "detailed" default.
          groupToolRuns: toolCallDetailLevel === "detailed",
        }),
      [
        context.status,
        baseRenderModel.history,
        baseRenderModel.segments.liveHead,
        baseRenderModel.turnTiming.byAssistantId,
        streamRenderStrategy,
        toolCallDetailLevel,
      ],
    );
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom(reason = "jump-to-bottom") {
          viewportRef.current?.scrollToBottom(reason);
        },
        prepareForViewportChange() {
          viewportRef.current?.prepareForViewportChange();
        },
      }),
      [],
    );

    const scrollToBottom = useCallback(() => {
      viewportRef.current?.scrollToBottom("jump-to-bottom");
    }, []);

    // A user-initiated tool-run summary expand/collapse changes content height in
    // the middle of history; tell the viewport to keep the row anchored instead
    // of re-pinning to the bottom (web), while streaming pin resumes after.
    const handleToolRunToggle = useStableEvent(() => {
      viewportRef.current?.suppressAutoStickForContentChange();
    });

    // After the expand/collapse commits (layout phase), flush the virtualizer so
    // sibling rows reposition before paint instead of one frame late.
    const handleToolRunLayoutChange = useStableEvent(() => {
      viewportRef.current?.flushRowMeasurements();
    });

    const setInlineDetailsExpanded = useCallback(
      (itemId: string, expanded: boolean) => {
        if (!streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion()) {
          return;
        }
        setExpandedInlineToolCallIds((previous) => {
          const next = new Set(previous);
          if (expanded) {
            next.add(itemId);
          } else {
            next.delete(itemId);
          }
          return next;
        });
      },
      [streamRenderStrategy],
    );

    const setToolCallGroupExpanded = useCallback((groupId: string, expanded: boolean) => {
      setExpandedToolCallGroupIds((previous) => {
        const next = new Set(previous);
        if (expanded) {
          next.add(groupId);
        } else {
          next.delete(groupId);
        }
        return next;
      });
    }, []);

    const renderUserMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "user_message" }>) => {
        return (
          <UserMessage
            serverId={resolvedServerId}
            agentId={agentId}
            messageId={item.id}
            message={item.text}
            images={item.images}
            attachments={item.attachments}
            timestamp={item.timestamp.getTime()}
            capabilities={context.capabilities}
            client={client}
            isFirstInGroup={layoutItem.isFirstInUserGroup}
            isLastInGroup={layoutItem.isLastInUserGroup}
          />
        );
      },
      [context.capabilities, agentId, client, resolvedServerId],
    );

    const renderAssistantMessageItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "assistant_message" }>) => {
        return (
          <AssistantFileLinkResolverProvider
            client={client}
            serverId={resolvedServerId}
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={handleInlinePathPress}
            toast={toast}
          >
            <AssistantMessage
              message={item.text}
              timestamp={item.timestamp.getTime()}
              workspaceRoot={workspaceRoot}
              serverId={resolvedServerId}
              client={client}
              spacing={layoutItem.assistantSpacing}
            />
          </AssistantFileLinkResolverProvider>
        );
      },
      [client, handleInlinePathPress, resolvedServerId, toast, workspaceRoot],
    );

    const renderThoughtItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "thought" }>) => {
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName="thinking"
            args={item.text}
            status={item.status === "ready" ? "completed" : "executing"}
            isLastInSequence={layoutItem.isLastInToolSequence}
            defaultExpanded={autoExpandReasoning}
            forceInline={autoExpandReasoning}
            collapseSignal={collapseSignal}
          />
        );
      },
      [autoExpandReasoning, setInlineDetailsExpanded, collapseSignal],
    );

    const renderSingleToolCallItem = useCallback(
      (
        item: Extract<StreamItem, { kind: "tool_call" }>,
        isLastInSequence: boolean,
        maxDetailHeight?: number,
      ) => {
        const { payload } = item;

        if (payload.source === "agent") {
          const data = payload.data;

          if (
            data.name === "speak" &&
            data.detail.type === "unknown" &&
            typeof data.detail.input === "string" &&
            data.detail.input.trim()
          ) {
            return (
              <SpeakMessage message={data.detail.input} timestamp={item.timestamp.getTime()} />
            );
          }

          return (
            <ToolCallSlot
              itemId={item.id}
              onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
              toolName={data.name}
              error={data.error}
              status={data.status}
              detail={data.detail}
              cwd={context.cwd}
              metadata={data.metadata}
              isLastInSequence={isLastInSequence}
              onOpenFilePath={handleToolCallOpenFile}
              collapseSignal={collapseSignal}
              maxDetailHeight={maxDetailHeight}
            />
          );
        }

        const data = payload.data;
        return (
          <ToolCallSlot
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={setInlineDetailsExpanded}
            toolName={data.toolName}
            args={data.arguments}
            result={data.result}
            status={data.status}
            isLastInSequence={isLastInSequence}
            onOpenFilePath={handleToolCallOpenFile}
            collapseSignal={collapseSignal}
            maxDetailHeight={maxDetailHeight}
          />
        );
      },
      [context.cwd, setInlineDetailsExpanded, handleToolCallOpenFile, collapseSignal],
    );

    const renderToolCallItem = useCallback(
      (layoutItem: StreamLayoutItem, item: Extract<StreamItem, { kind: "tool_call" }>) => {
        const group = projectedToolCalls.groupsByHostId.get(item.id);
        if (!group) {
          return renderSingleToolCallItem(item, layoutItem.isLastInToolSequence);
        }
        const expanded = expandedToolCallGroupIds.has(group.run.id);
        return (
          <OverviewToolCallGroupView
            group={group}
            expanded={expanded}
            isCompact={isMobile}
            isLastInSequence={layoutItem.isLastInToolSequence}
            onExpandedChange={setToolCallGroupExpanded}
            cwd={context.cwd}
          >
            {expanded
              ? group.run.calls.map((call, index) => (
                  <React.Fragment key={call.id}>
                    {renderSingleToolCallItem(
                      call,
                      index === group.run.calls.length - 1,
                      GROUPED_TOOL_CALL_DETAIL_MAX_HEIGHT,
                    )}
                  </React.Fragment>
                ))
              : null}
          </OverviewToolCallGroupView>
        );
      },
      [
        projectedToolCalls.groupsByHostId,
        context.cwd,
        expandedToolCallGroupIds,
        isMobile,
        renderSingleToolCallItem,
        setToolCallGroupExpanded,
      ],
    );

    // Renders a single member of a collapsed tool run (thought / tool_call)
    // without the grouping branch, so the run's anchor item can render its members
    // without recursing back into the summary wrapper. todo_list is never grouped
    // (see isGroupableToolItem), so it never reaches here.
    const renderToolRunChild = useCallback(
      (childItem: StreamLayoutItem): ReactNode => {
        const item = childItem.item;
        switch (item.kind) {
          case "thought":
            return renderThoughtItem(childItem, item);
          case "tool_call":
            return renderToolCallItem(childItem, item);
          default:
            return null;
        }
      },
      [renderThoughtItem, renderToolCallItem],
    );

    const renderStreamItemContent = useCallback(
      (layoutItem: StreamLayoutItem) => {
        if (layoutItem.isToolRunMember) {
          return null;
        }
        const toolRunGroup = layoutItem.toolRunGroup;
        if (toolRunGroup) {
          return (
            <ToolRunSummary
              childItems={toolRunGroup.items}
              defaultExpanded={toolRunGroup.isActive}
              renderChild={renderToolRunChild}
              onUserToggle={handleToolRunToggle}
              onExpandedLayoutChange={handleToolRunLayoutChange}
              collapseSignal={collapseSignal}
            />
          );
        }
        const item = layoutItem.item;
        switch (item.kind) {
          case "user_message":
            return renderUserMessageItem(layoutItem, item);

          case "assistant_message":
            return renderAssistantMessageItem(layoutItem, item);

          case "thought":
            return renderThoughtItem(layoutItem, item);

          case "tool_call":
            return renderToolCallItem(layoutItem, item);

          case "activity_log":
            return (
              <ActivityLog
                type={item.activityType}
                message={item.message}
                timestamp={item.timestamp.getTime()}
                metadata={item.metadata}
              />
            );

          case "todo_list":
            return <TodoListCard items={item.items} collapseSignal={collapseSignal} />;

          case "compaction":
            return (
              <CompactionMarker
                status={item.status}
                trigger={item.trigger}
                preTokens={item.preTokens}
              />
            );

          default:
            return null;
        }
      },
      [
        renderUserMessageItem,
        renderAssistantMessageItem,
        renderThoughtItem,
        renderToolCallItem,
        renderToolRunChild,
        handleToolRunToggle,
        handleToolRunLayoutChange,
        collapseSignal,
      ],
    );

    const bottomTurnFooterHost = streamLayout.auxiliaryTurnFooter;

    const renderStreamItem = useCallback(
      (layoutItem: StreamLayoutItem) => {
        const content = renderStreamItemContent(layoutItem);
        return renderStreamItemWithTurnFooter({
          content,
          layoutItem,
          strategy: streamRenderStrategy,
          supportsTimelineCursor: supportsAgentForkContextCursor,
          onForkAssistantTurn: readOnly ? undefined : handleForkAssistantTurn,
        });
      },
      [
        handleForkAssistantTurn,
        readOnly,
        renderStreamItemContent,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );

    const pendingPermissionItems = useMemo(
      () => Array.from(pendingPermissions.values()).filter((perm) => perm.agentId === agentId),
      [pendingPermissions, agentId],
    );

    const showRunningTurnFooter = context.status === "running";
    const pendingPermissionsNode = useMemo(
      () =>
        renderPendingPermissionsNode({
          pendingPermissions: pendingPermissionItems,
          client,
        }),
      [client, pendingPermissionItems],
    );
    const turnFooterNode = useMemo(
      () =>
        showRunningTurnFooter || bottomTurnFooterHost ? (
          <TurnFooter
            isRunning={showRunningTurnFooter}
            inFlightTurnStartedAt={baseRenderModel.turnTiming.runningStartedAt}
            host={bottomTurnFooterHost}
            strategy={streamRenderStrategy}
            supportsTimelineCursor={supportsAgentForkContextCursor}
            onForkAssistantTurn={readOnly ? undefined : handleForkAssistantTurn}
          />
        ) : null,
      [
        handleForkAssistantTurn,
        readOnly,
        showRunningTurnFooter,
        baseRenderModel.turnTiming.runningStartedAt,
        bottomTurnFooterHost,
        streamRenderStrategy,
        supportsAgentForkContextCursor,
      ],
    );
    const renderModel = useMemo<AgentStreamRenderModel>(() => {
      return {
        ...baseRenderModel,
        boundary: baseRenderModel.boundary,
        auxiliary: {
          pendingPermissions: pendingPermissionsNode,
          turnFooter: turnFooterNode,
        },
      };
    }, [baseRenderModel, pendingPermissionsNode, turnFooterNode]);

    const emptyStateStyle = useMemo(() => [stylesheet.emptyState, stylesheet.contentWrapper], []);
    const listEmptyComponent = useMemo(
      () =>
        renderListEmptyComponent({
          renderModel,
          emptyStateStyle,
          emptyText: t("agentStream.empty"),
        }),
      [renderModel, emptyStateStyle, t],
    );

    const { boundary, auxiliary } = renderModel;

    const layoutHistoryItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.history) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.history]);

    const layoutLiveHeadItemById = useMemo(() => {
      const itemById = new Map<string, StreamLayoutItem>();
      for (const item of streamLayout.liveHead) {
        itemById.set(item.item.id, item);
      }
      return itemById;
    }, [streamLayout.liveHead]);

    const renderHistoryRow = useCallback(
      (item: StreamItem) =>
        renderHistoryStreamItem({
          item,
          layoutItemById: layoutHistoryItemById,
          renderStreamItem,
        }),
      [layoutHistoryItemById, renderStreamItem],
    );

    const renderHistoryVirtualizedRow = useCallback<
      StreamSegmentRenderers["renderHistoryVirtualizedRow"]
    >((item) => renderHistoryRow(item), [renderHistoryRow]);
    const renderHistoryMountedRow = useCallback<StreamSegmentRenderers["renderHistoryMountedRow"]>(
      (item) => renderHistoryRow(item),
      [renderHistoryRow],
    );
    // useStableEvent keeps the function reference stable across flushes.
    // layoutLiveHeadItemById and renderStreamItem are read from the ref at call time,
    // so the live-head render always uses the latest layout without causing renderers
    // to be a new object on every text-chunk flush.
    const renderLiveHeadRow: StreamSegmentRenderers["renderLiveHeadRow"] = useStableEvent(
      (item: StreamItem) =>
        renderLiveHeadStreamItem({
          item,
          layoutItemById: layoutLiveHeadItemById,
          renderStreamItem,
        }),
    );
    const renderLiveAuxiliary = useCallback<StreamSegmentRenderers["renderLiveAuxiliary"]>(() => {
      return renderLiveAuxiliaryNode({
        pendingPermissions: auxiliary.pendingPermissions,
        turnFooter: auxiliary.turnFooter,
      });
    }, [auxiliary.pendingPermissions, auxiliary.turnFooter]);

    const renderers = useMemo<StreamSegmentRenderers>(
      () => ({
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      }),
      [
        renderHistoryVirtualizedRow,
        renderHistoryMountedRow,
        renderLiveHeadRow,
        renderLiveAuxiliary,
      ],
    );

    const streamScrollEnabled =
      !streamRenderStrategy.shouldDisableParentScrollOnInlineDetailsExpansion() ||
      expandedInlineToolCallIds.size === 0;
    const historyRowRevision = useMemo(
      () => ({
        contentById: projectedToolCalls.historyGroupUpdatesByHostId,
        displayStateById: expandedToolCallGroupIds,
        globalDisplayState: isMobile,
      }),
      [expandedToolCallGroupIds, isMobile, projectedToolCalls.historyGroupUpdatesByHostId],
    );

    // Only surface the collapse/expand-all toggle once there is stream content
    // that owns its own expansion (tool calls, thinking, task cards).
    const hasStreamContent =
      boundary.hasVirtualizedHistory || boundary.hasMountedHistory || boundary.hasLiveHead;

    return (
      <ToolCallSheetProvider>
        <View style={stylesheet.container}>
          <MessageOuterSpacingProvider disableOuterSpacing>
            <TranscriptZoomLayer zoom={transcriptZoom}>
              {streamRenderStrategy.render({
                agentId,
                segments: renderModel.segments,
                historyRowRevision,
                liveHeadRowRevision: expandedToolCallGroupIds,
                boundary,
                renderers,
                listEmptyComponent,
                viewportRef,
                routeBottomAnchorRequest,
                isAuthoritativeHistoryReady,
                onNearBottomChange: setIsNearBottom,
                onNearHistoryStart: loadOlder,
                isLoadingOlderHistory: isLoadingOlder,
                hasOlderHistory: hasOlder,
                scrollEnabled: streamScrollEnabled,
                listStyle: stylesheet.list,
                baseListContentContainerStyle: stylesheet.listContentContainer,
                forwardListContentContainerStyle: stylesheet.forwardListContentContainer,
              })}
            </TranscriptZoomLayer>
          </MessageOuterSpacingProvider>
          {hasStreamContent && (
            <View style={stylesheet.collapseToggleContainer} pointerEvents="box-none">
              <View style={stylesheet.collapseToggleInner} pointerEvents="box-none">
                <View style={stylesheet.toggleRow} pointerEvents="box-none">
                  {isWeb && <TranscriptZoomControl />}
                  <Pressable
                    style={collapseToggleButtonStyle}
                    onPress={handleToggleCollapseAll}
                    accessibilityRole="button"
                    accessibilityLabel={
                      collapseSignal.expanded
                        ? t("message.actions.collapseAll")
                        : t("message.actions.expandAll")
                    }
                    testID="collapse-all-toggle"
                  >
                    {collapseSignal.expanded ? (
                      <ThemedChevronsDownUp size={18} uniProps={collapseToggleColorMapping} />
                    ) : (
                      <ThemedChevronsUpDown size={18} uniProps={collapseToggleColorMapping} />
                    )}
                  </Pressable>
                </View>
              </View>
            </View>
          )}
          {!isNearBottom && (
            <View style={stylesheet.scrollToBottomContainer} pointerEvents="box-none">
              <Animated.View entering={scrollIndicatorFadeIn} exiting={scrollIndicatorFadeOut}>
                <Pressable
                  style={stylesheet.scrollToBottomButton}
                  onPress={scrollToBottom}
                  accessibilityRole="button"
                  accessibilityLabel={t("agentStream.scrollToBottom")}
                  testID="scroll-to-bottom-button"
                >
                  <ChevronDown size={24} color={stylesheet.scrollToBottomIcon.color} />
                </Pressable>
              </Animated.View>
            </View>
          )}
        </View>
      </ToolCallSheetProvider>
    );
  },
);

function agentCapabilityFlagsEqual(
  left: AgentCapabilityFlags | undefined,
  right: AgentCapabilityFlags | undefined,
): boolean {
  return AGENT_CAPABILITY_FLAG_KEYS.every((key) => left?.[key] === right?.[key]);
}

function collectAgentProjectPlacementDiffs(
  left: AgentScreenAgent["projectPlacement"],
  right: AgentScreenAgent["projectPlacement"],
): string[] {
  const reasons: string[] = [];
  if (left?.checkout?.cwd !== right?.checkout?.cwd) {
    reasons.push("agent.projectPlacement.checkout.cwd");
  }
  if (left?.checkout?.isGit !== right?.checkout?.isGit) {
    reasons.push("agent.projectPlacement.checkout.isGit");
  }
  if (left?.projectName !== right?.projectName) {
    reasons.push("agent.projectPlacement.projectName");
  }
  if (left?.projectKey !== right?.projectKey) {
    reasons.push("agent.projectPlacement.projectKey");
  }
  return reasons;
}

function collectAgentSetupDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.provider !== right.provider) reasons.push("agent.provider");
  if (left.currentModeId !== right.currentModeId) reasons.push("agent.currentModeId");
  if (left.model !== right.model) reasons.push("agent.model");
  if (left.thinkingOptionId !== right.thinkingOptionId) {
    reasons.push("agent.thinkingOptionId");
  }
  if (left.runtimeInfo?.modeId !== right.runtimeInfo?.modeId) {
    reasons.push("agent.runtimeInfo.modeId");
  }
  if (left.runtimeInfo?.model !== right.runtimeInfo?.model) {
    reasons.push("agent.runtimeInfo.model");
  }
  if (left.runtimeInfo?.thinkingOptionId !== right.runtimeInfo?.thinkingOptionId) {
    reasons.push("agent.runtimeInfo.thinkingOptionId");
  }
  if (left.features !== right.features) reasons.push("agent.features");
  return reasons;
}

function collectAgentScreenAgentDiffs(left: AgentScreenAgent, right: AgentScreenAgent): string[] {
  const reasons: string[] = [];
  if (left.serverId !== right.serverId) reasons.push("agent.serverId");
  if (left.id !== right.id) reasons.push("agent.id");
  if (left.workspaceId !== right.workspaceId) reasons.push("agent.workspaceId");
  if (left.status !== right.status) reasons.push("agent.status");
  if (left.cwd !== right.cwd) reasons.push("agent.cwd");
  if (!agentCapabilityFlagsEqual(left.capabilities, right.capabilities)) {
    reasons.push("agent.capabilities");
  }
  if (left.lastError !== right.lastError) reasons.push("agent.lastError");
  reasons.push(...collectAgentSetupDiffs(left, right));
  reasons.push(...collectAgentProjectPlacementDiffs(left.projectPlacement, right.projectPlacement));
  return reasons;
}

function bottomAnchorRouteRequestsEqual(
  left: BottomAnchorRouteRequest | null | undefined,
  right: BottomAnchorRouteRequest | null | undefined,
): boolean {
  return (
    left?.agentId === right?.agentId &&
    left?.reason === right?.reason &&
    left?.requestKey === right?.requestKey
  );
}

function resolveServerId(
  serverId: string | undefined,
  contextServerId: string | undefined,
): string {
  return serverId ?? contextServerId ?? "";
}

interface ResolvedHistoryPagination {
  isLoadingOlder: boolean;
  hasOlder: boolean;
  loadOlder: () => void;
}

// Prefer the caller-supplied pagination (used by the provider-subagent panel) over
// the built-in agent-history hook. Kept module-level to hold down the component's
// cyclomatic complexity.
function resolveHistoryPagination(
  override: AgentStreamViewProps["historyPagination"],
  fallback: ResolvedHistoryPagination,
): ResolvedHistoryPagination {
  if (!override) {
    return fallback;
  }
  return {
    isLoadingOlder: override.isLoadingOlder,
    hasOlder: override.hasOlder,
    loadOlder: override.onLoadOlder,
  };
}

function historyPaginationPropsEqual(
  left: AgentStreamViewProps["historyPagination"],
  right: AgentStreamViewProps["historyPagination"],
): boolean {
  return (
    left?.hasOlder === right?.hasOlder &&
    left?.isLoadingOlder === right?.isLoadingOlder &&
    left?.onLoadOlder === right?.onLoadOlder
  );
}

function agentStreamViewPropsEqual(
  left: AgentStreamViewProps,
  right: AgentStreamViewProps,
): boolean {
  const reasons: string[] = [];
  if (left.agentId !== right.agentId) reasons.push("agentId");
  if (left.serverId !== right.serverId) reasons.push("serverId");
  reasons.push(...collectAgentScreenAgentDiffs(left.context, right.context));
  if (left.streamItems !== right.streamItems) reasons.push("streamItems");
  if (left.streamHead !== right.streamHead) reasons.push("streamHead");
  if (left.pendingPermissions !== right.pendingPermissions) reasons.push("pendingPermissions");
  if (
    !bottomAnchorRouteRequestsEqual(left.routeBottomAnchorRequest, right.routeBottomAnchorRequest)
  ) {
    reasons.push("routeBottomAnchorRequest");
  }
  if (left.isAuthoritativeHistoryReady !== right.isAuthoritativeHistoryReady) {
    reasons.push("isAuthoritativeHistoryReady");
  }
  if (left.toast !== right.toast) reasons.push("toast");
  if (left.onOpenWorkspaceFile !== right.onOpenWorkspaceFile) reasons.push("onOpenWorkspaceFile");
  if (left.readOnly !== right.readOnly) reasons.push("readOnly");
  if (!historyPaginationPropsEqual(left.historyPagination, right.historyPagination)) {
    reasons.push("historyPagination");
  }
  recordRenderProfileReasons(`AgentStreamView:${right.agentId}`, reasons);
  return reasons.length === 0;
}

export const AgentStreamView = memo(AgentStreamViewComponent, agentStreamViewPropsEqual);
AgentStreamView.displayName = "AgentStreamView";

interface ToolCallSlotProps extends Omit<
  ComponentProps<typeof ToolCall>,
  "onInlineDetailsExpandedChange"
> {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (itemId: string, expanded: boolean) => void;
}

function ToolCallSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  ...rest
}: ToolCallSlotProps) {
  const handleExpandedChange = useCallback(
    (expanded: boolean) => onInlineDetailsExpandedChangeByItemId(itemId, expanded),
    [onInlineDetailsExpandedChangeByItemId, itemId],
  );
  return <ToolCall {...rest} onInlineDetailsExpandedChange={handleExpandedChange} />;
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCheckIcon = withUnistyles(Check);
const ThemedXIcon = withUnistyles(X);
const ThemedChevronsDownUp = withUnistyles(ChevronsDownUp);
const ThemedChevronsUpDown = withUnistyles(ChevronsUpDown);
const ThemedZoomIn = withUnistyles(ZoomIn);
const ThemedZoomOut = withUnistyles(ZoomOut);
const collapseToggleColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});

const primaryColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

// Web-only stepped zoom for the agent transcript. Reads/writes the persisted
// `transcriptZoom` setting; the transcript view applies it as CSS `zoom`.
// Extracted so the stepping logic and its JSX don't inflate AgentStreamView.
function TranscriptZoomControl() {
  const { t } = useTranslation();
  const transcriptZoom = useSettings((settings) => settings.transcriptZoom);
  const { updateSettings } = useSettings();
  const zoomLevels = TRANSCRIPT_ZOOM_LEVELS as readonly number[];
  const currentIndex =
    zoomLevels.indexOf(transcriptZoom) === -1
      ? zoomLevels.indexOf(DEFAULT_TRANSCRIPT_ZOOM)
      : zoomLevels.indexOf(transcriptZoom);
  const canZoomOut = currentIndex > 0;
  const canZoomIn = currentIndex < zoomLevels.length - 1;
  const setZoom = useCallback(
    (level: number) => {
      if (level !== transcriptZoom) {
        void updateSettings({ transcriptZoom: level });
      }
    },
    [transcriptZoom, updateSettings],
  );
  const handleZoomOut = useCallback(() => {
    if (canZoomOut) setZoom(zoomLevels[currentIndex - 1]);
  }, [canZoomOut, currentIndex, setZoom, zoomLevels]);
  const handleZoomIn = useCallback(() => {
    if (canZoomIn) setZoom(zoomLevels[currentIndex + 1]);
  }, [canZoomIn, currentIndex, setZoom, zoomLevels]);
  const handleReset = useCallback(() => setZoom(DEFAULT_TRANSCRIPT_ZOOM), [setZoom]);
  const zoomButtonStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      stylesheet.zoomButton,
      hovered ? stylesheet.zoomButtonHovered : null,
      pressed ? stylesheet.zoomButtonPressed : null,
    ],
    [],
  );
  return (
    <View style={stylesheet.zoomControl}>
      <Pressable
        style={zoomButtonStyle}
        onPress={handleZoomOut}
        disabled={!canZoomOut}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.zoom.out")}
        testID="transcript-zoom-out"
      >
        <ThemedZoomOut
          size={15}
          uniProps={canZoomOut ? collapseToggleColorMapping : mutedColorMapping}
        />
      </Pressable>
      <Pressable
        onPress={handleReset}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.zoom.reset")}
        testID="transcript-zoom-reset"
      >
        <Text style={stylesheet.zoomLabel}>{`${Math.round(transcriptZoom * 100)}%`}</Text>
      </Pressable>
      <Pressable
        style={zoomButtonStyle}
        onPress={handleZoomIn}
        disabled={!canZoomIn}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.zoom.in")}
        testID="transcript-zoom-in"
      >
        <ThemedZoomIn
          size={15}
          uniProps={canZoomIn ? collapseToggleColorMapping : mutedColorMapping}
        />
      </Pressable>
    </View>
  );
}

const pressableStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  permissionStyles.optionButton,
  hovered ? permissionStyles.optionButtonHovered : null,
  pressed ? permissionStyles.optionButtonPressed : null,
];

interface PermissionActionButtonProps {
  action: AgentPermissionAction;
  isRespondingAction: boolean;
  isResponding: boolean;
  isPrimary: boolean;
  Icon: typeof ThemedCheckIcon;
  testID: string;
  onPress: (action: AgentPermissionAction) => void;
}

function PermissionActionButton({
  action,
  isRespondingAction,
  isResponding,
  isPrimary,
  Icon,
  testID,
  onPress,
}: PermissionActionButtonProps) {
  const handlePress = useCallback(() => onPress(action), [onPress, action]);
  const optionTextStyle = isPrimary ? optionTextPrimaryStyle : permissionStyles.optionText;
  const colorMapping = isPrimary ? primaryColorMapping : mutedColorMapping;
  return (
    <Pressable testID={testID} style={pressableStyle} onPress={handlePress} disabled={isResponding}>
      {isRespondingAction ? (
        <ThemedActivityIndicator size="small" uniProps={colorMapping} />
      ) : (
        <View style={permissionStyles.optionContent}>
          <Icon size={14} uniProps={colorMapping} />
          <Text style={optionTextStyle}>{action.label}</Text>
        </View>
      )}
    </Pressable>
  );
}

function PermissionRequestCard({
  permission,
  client,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();

  const { request } = permission;
  const isPlanRequest = request.kind === "plan";
  const title = isPlanRequest
    ? t("agentStream.permission.plan")
    : (request.title ?? request.name ?? t("agentStream.permission.required"));
  const description = request.description ?? "";
  const resolvedToolCallDetail = useMemo(
    () =>
      request.detail ?? {
        type: "unknown" as const,
        input: request.input ?? null,
        output: null,
      },
    [request.detail, request.input],
  );
  const resolvedActions = useMemo((): AgentPermissionAction[] => {
    if (request.kind === "question") {
      return [];
    }
    if (Array.isArray(request.actions) && request.actions.length > 0) {
      return request.actions;
    }
    return [
      {
        id: "reject",
        label: t("agentStream.permission.deny"),
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      },
      {
        id: "accept",
        label: isPlanRequest
          ? t("agentStream.permission.implement")
          : t("agentStream.permission.accept"),
        behavior: "allow",
        variant: "primary",
      },
    ];
  }, [isPlanRequest, request, t]);

  const planMarkdown = useMemo(() => {
    if (!request) {
      return undefined;
    }
    const planFromMetadata =
      typeof request.metadata?.planText === "string" ? request.metadata.planText : undefined;
    if (planFromMetadata) {
      return planFromMetadata;
    }
    const candidate = request.input?.["plan"];
    if (typeof candidate === "string") {
      return candidate;
    }
    return undefined;
  }, [request]);

  const permissionMutation = useMutation({
    mutationFn: async (input: {
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
    }) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return client.respondToPermissionAndWait(
        input.agentId,
        input.requestId,
        input.response,
        15000,
      );
    },
  });
  const {
    reset: resetPermissionMutation,
    mutateAsync: respondToPermission,
    isPending: isResponding,
  } = permissionMutation;

  const [respondingActionId, setRespondingActionId] = useState<string | null>(null);

  useEffect(() => {
    resetPermissionMutation();
    setRespondingActionId(null);
  }, [permission.request.id, resetPermissionMutation]);
  const handleResponse = useCallback(
    (response: AgentPermissionResponse) => {
      respondToPermission({
        agentId: permission.agentId,
        requestId: permission.request.id,
        response,
      }).catch((error) => {
        console.error("[PermissionRequestCard] Failed to respond to permission:", error);
      });
    },
    [permission.agentId, permission.request.id, respondToPermission],
  );
  const handleActionPress = useCallback(
    (action: AgentPermissionAction) => {
      setRespondingActionId(action.id);
      if (action.behavior === "allow") {
        handleResponse({
          behavior: "allow",
          selectedActionId: action.id,
        });
        return;
      }
      handleResponse({
        behavior: "deny",
        selectedActionId: action.id,
        message: "Denied by user",
      });
    },
    [handleResponse],
  );

  const optionsContainerStyle = useMemo(
    () => [
      permissionStyles.optionsContainer,
      !isMobile && permissionStyles.optionsContainerDesktop,
    ],
    [isMobile],
  );

  if (request.kind === "question") {
    return (
      <QuestionFormCard
        permission={permission}
        onRespond={handleResponse}
        isResponding={isResponding}
      />
    );
  }

  const footer = (
    <>
      <Text testID="permission-request-question" style={permissionStyles.question}>
        {t("agentStream.permission.question")}
      </Text>

      <View style={optionsContainerStyle}>
        {resolvedActions.map((action) => {
          const isPrimary = action.variant === "primary";
          const isRespondingAction = respondingActionId === action.id;
          const Icon = action.behavior === "allow" ? ThemedCheckIcon : ThemedXIcon;
          let testID: string;
          if (action.behavior === "deny") testID = "permission-request-deny";
          else if (action.id === "accept" || action.id === "implement")
            testID = "permission-request-accept";
          else testID = `permission-request-action-${action.id}`;

          return (
            <PermissionActionButton
              key={action.id}
              action={action}
              isRespondingAction={isRespondingAction}
              isResponding={isResponding}
              isPrimary={isPrimary}
              Icon={Icon}
              testID={testID}
              onPress={handleActionPress}
            />
          );
        })}
      </View>
    </>
  );

  if (isPlanRequest && planMarkdown) {
    return (
      <PlanCard
        title={title}
        description={description}
        text={planMarkdown}
        footer={footer}
        testID="permission-plan-card"
        disableOuterSpacing
      />
    );
  }

  return (
    <View style={permissionStyles.container}>
      <Text style={permissionStyles.title}>{title}</Text>

      {description ? <Text style={permissionStyles.description}>{description}</Text> : null}

      {planMarkdown ? (
        <PlanCard
          title={t("agentStream.permission.proposedPlan")}
          text={planMarkdown}
          testID="permission-plan-card"
          disableOuterSpacing
        />
      ) : null}

      {!isPlanRequest ? (
        <ToolCallDetailsContent detail={resolvedToolCallDetail} maxHeight={200} />
      ) : null}

      {footer}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  listContentContainer: {
    paddingVertical: 0,
    flexGrow: 1,
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  forwardListContentContainer: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  list: {
    flex: 1,
  },
  streamItemWrapper: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[12],
  },
  permissionsContainer: {
    gap: theme.spacing[2],
  },
  listHeaderContent: {
    gap: theme.spacing[3],
  },
  syncingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
  },
  syncingIndicatorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  invertedWrapper: {
    transform: [{ scaleY: -1 }],
    width: "100%",
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  collapseToggleContainer: {
    position: "absolute",
    top: theme.spacing[2],
    left: 0,
    right: 0,
    alignItems: "center",
    pointerEvents: "box-none",
  },
  collapseToggleInner: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    alignItems: "flex-end",
    paddingHorizontal: theme.spacing[2],
  },
  collapseToggleButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  collapseToggleButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  collapseToggleButtonPressed: {
    opacity: 0.7,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  zoomControl: {
    flexDirection: "row",
    alignItems: "center",
    height: 32,
    paddingHorizontal: theme.spacing[1],
    gap: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  zoomButton: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  zoomButtonPressed: {
    opacity: 0.7,
  },
  zoomLabel: {
    minWidth: 38,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  scrollToBottomContainer: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scrollToBottomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  scrollToBottomIcon: {
    color: theme.colors.foreground,
  },
}));

const permissionStyles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
  },
  question: {
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  optionsContainer: {
    gap: theme.spacing[2],
  },
  optionsContainerDesktop: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    width: "100%",
  },
  optionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  optionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  optionButtonPressed: {
    opacity: 0.9,
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  optionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  optionTextPrimary: {
    color: theme.colors.foreground,
  },
}));

const optionTextPrimaryStyle = [permissionStyles.optionText, permissionStyles.optionTextPrimary];

interface StreamItemWrapperProps {
  gapBelow: number;
  children: ReactNode;
}

function StreamItemWrapper({ gapBelow, children }: StreamItemWrapperProps) {
  const wrapperStyle = useMemo(
    () => [stylesheet.streamItemWrapper, { marginBottom: gapBelow }],
    [gapBelow],
  );
  return <View style={wrapperStyle}>{children}</View>;
}
