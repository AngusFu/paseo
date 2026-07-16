import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ServerDiffToolsCapability } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { DiffStat } from "@/components/diff-stat";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type PressableStateCallbackType,
  type FlatListProps,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  BORDER_WIDTH,
  FONT_SIZE,
  ICON_SIZE,
  SPACING,
  type DiffFontSizeStep,
  type Theme,
} from "@/styles/theme";
import { DIFF_FONT_SIZE_STEPS, resolveDiffFontSize } from "@/git/diff-font-size";
import { useIsCompactFormFactor, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import {
  AlignJustify,
  Archive,
  ArrowDownUp,
  ChevronDown,
  Columns2,
  Download,
  FolderTree,
  GitCommitHorizontal,
  GitMerge,
  List,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Pilcrow,
  RefreshCcw,
  RotateCw,
  Upload,
  WrapText,
} from "lucide-react-native";
import {
  useCheckoutDiffQuery,
  type ParsedDiffFile,
  type DiffLine,
  type HighlightToken,
  type DiffToolId,
  type GitDiffAlgorithm,
} from "@/git/use-diff-query";
import { buildDiffFlatItems, sumHeightsBefore, type DiffFlatItem } from "@/git/diff-flat-items";
import { buildDiffTree, collectDirPaths, compressSingleChildChains } from "@/git/diff-tree";
import { DiffFolderRow } from "@/git/diff-folder-row";
import { TreeIndentGuides, treeRowPaddingLeft } from "@/components/tree-primitives";
import { SvgXml } from "react-native-svg";
import { getFileIconSvg } from "@/components/material-file-icons";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { CommitsSection } from "@/git/commits-section/commits-section";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { DiffScroll } from "@/components/diff-scroll";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { shouldAnchorHeaderBeforeCollapse } from "@/git/diff-scroll";
import {
  buildSplitDiffRows,
  buildUnifiedDiffLines,
  type ReviewableDiffTarget,
  type SplitDiffDisplayLine,
  type SplitDiffRow,
} from "@/utils/diff-layout";
import { splitTokensByChangeRanges, type WordChangeRange } from "@/utils/diff-word-highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { lineNumberGutterWidth } from "@/components/code-insets";
import { useWebScrollViewScrollbar } from "@/components/use-web-scrollbar";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { BranchSwitcher } from "@/components/branch-switcher";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDiffToolsCapability } from "@/hooks/use-diff-tools-capability";
import { useInstallDifftastic, type InstallDifftasticStatus } from "@/hooks/use-install-difftastic";
import { useGitActions } from "@/git/use-actions";
import { buildForgeSignInCommand, getForgePresentation, type Forge } from "@/git/forge";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import type { ForgeAuthState } from "@getpaseo/protocol/messages";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import {
  formatDiffContentText,
  formatDiffGutterText,
  hasVisibleDiffTokens,
} from "@/utils/diff-rendering";
import { isWeb, isNative } from "@/constants/platform";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftScopeKey,
  buildReviewDraftKey,
  useReviewAttachmentSnapshot,
  useResolvedDiffMode,
  useSetDiffModeOverride,
  type ReviewDraftComment,
  getInlineReviewThreadState,
  getSplitInlineReviewThreadState,
  InlineReviewGutterCell,
  InlineReviewThread,
  isInlineReviewEditorForTarget,
  useInlineReviewController,
  type InlineReviewActions,
} from "@/review";

export type { GitActionId, GitAction, GitActions } from "@/git/policy";

function fileHeaderPressableStyle({ pressed }: PressableStateCallbackType) {
  return [styles.fileHeader, pressed && styles.fileHeaderPressed];
}

interface HighlightedTextProps {
  tokens: HighlightToken[];
  textMetricsStyle: TextStyle;
  wrapLines?: boolean;
  testID?: string;
  // Word-level changed char ranges (code coordinate space) and the tint applied
  // to those spans. When absent, tokens render without intra-line emphasis.
  changedRanges?: WordChangeRange[];
  changedHighlightStyle?: StyleProp<TextStyle>;
}

type WrappedWebTextStyle = TextStyle & {
  whiteSpace?: "pre" | "pre-wrap";
  overflowWrap?: "normal" | "anywhere";
};

function getWrappedTextStyle(wrapLines: boolean): WrappedWebTextStyle | undefined {
  if (isNative) {
    return undefined;
  }
  return wrapLines
    ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" }
    : { whiteSpace: "pre", overflowWrap: "normal" };
}

function getNumericLineHeight(textMetricsStyle: TextStyle): number | undefined {
  const { lineHeight } = textMetricsStyle;
  return typeof lineHeight === "number" && Number.isFinite(lineHeight) ? lineHeight : undefined;
}

function useDiffRowMetricsStyle(textMetricsStyle: TextStyle): StyleProp<ViewStyle> {
  const lineHeight = getNumericLineHeight(textMetricsStyle);
  return useMemo(
    () => (lineHeight !== undefined ? inlineUnistylesStyle({ minHeight: lineHeight }) : null),
    [lineHeight],
  );
}

function HighlightedToken({ token }: { token: HighlightToken }) {
  return <Text style={syntaxTokenStyleFor(token.style)}>{token.text}</Text>;
}

function HighlightedText({
  tokens,
  textMetricsStyle,
  wrapLines = false,
  testID,
  changedRanges,
  changedHighlightStyle,
}: HighlightedTextProps) {
  const containerStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
    ],
    [textMetricsStyle, wrapLines],
  );

  const keyedTokens = useMemo(
    () => tokens.map((token, index) => ({ key: `${index}-${token.text}`, token })),
    [tokens],
  );

  const keyedPieces = useMemo(() => {
    if (!changedRanges || changedRanges.length === 0) {
      return null;
    }
    return splitTokensByChangeRanges(tokens, changedRanges).map((piece, index) => ({
      key: `${index}-${piece.text}`,
      text: piece.text,
      changed: piece.changed,
      style: piece.changed
        ? [syntaxTokenStyleFor(piece.style), changedHighlightStyle]
        : syntaxTokenStyleFor(piece.style),
    }));
  }, [tokens, changedRanges, changedHighlightStyle]);

  if (keyedPieces) {
    return (
      <Text style={containerStyle} testID={testID}>
        {keyedPieces.map(({ key, text, changed, style }) => (
          <Text key={key} style={style} {...(changed ? WORD_HIGHLIGHT_TEST_PROPS : null)}>
            {text}
          </Text>
        ))}
      </Text>
    );
  }

  return (
    <Text style={containerStyle} testID={testID}>
      {keyedTokens.map(({ key, token }) => (
        <HighlightedToken key={key} token={token} />
      ))}
    </Text>
  );
}

// Web-only test hook so Playwright can assert intra-line highlight spans exist.
const WORD_HIGHLIGHT_TEST_PROPS = isWeb
  ? ({ dataSet: { diffWordChanged: "true" } } as const)
  : null;

interface DiffFileSectionProps {
  file: ParsedDiffFile;
  isExpanded: boolean;
  /** Tree indentation level (0 on the flat/mobile path). */
  depth?: number;
  /** Show the muted directory suffix (flat list); false inside the folder tree. */
  showDir?: boolean;
  interactive?: boolean;
  onToggle?: (path: string) => void;
  onHeaderHeightChange?: (path: string, height: number) => void;
  testID?: string;
  // The pane's selected engine (see DiffEngineMenu). Used to badge files that fell back to
  // git line-level diffing while the rest of the diff uses a structural engine.
  activeDiffTool?: DiffToolId;
}

const EMPTY_COMMENTS: readonly ReviewDraftComment[] = [];

function noopStartComment(): void {}

const DIFF_LINE_HOVER_STYLE = isWeb ? ({ cursor: "auto" } as const) : null;

function LongPressableLine({
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
  style,
  children,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions: InlineReviewActions | undefined;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const onStartComment = reviewActions?.onStartComment;
  const handlePress = useCallback(() => {
    if (reviewTarget && onStartComment) {
      onStartComment(reviewTarget);
    }
  }, [reviewTarget, onStartComment]);

  const handleHoverIn = useCallback(() => {
    onHoverChange?.(true);
    if (hoverTargetKey) {
      onHoverTargetChange?.(hoverTargetKey);
    }
  }, [hoverTargetKey, onHoverChange, onHoverTargetChange]);
  const handleHoverOut = useCallback(() => {
    onHoverChange?.(false);
    if (hoverTargetKey) {
      onHoverTargetChange?.(null);
    }
  }, [hoverTargetKey, onHoverChange, onHoverTargetChange]);
  const hoverStyle = useMemo(() => [style, DIFF_LINE_HOVER_STYLE], [style]);

  if (isWeb && (onHoverChange || onHoverTargetChange)) {
    return (
      <Pressable onHoverIn={handleHoverIn} onHoverOut={handleHoverOut} style={hoverStyle}>
        {children}
      </Pressable>
    );
  }

  if (!isNative || !reviewTarget || !onStartComment) {
    return <View style={style}>{children}</View>;
  }
  return (
    <Pressable onPress={handlePress} style={style}>
      {children}
    </Pressable>
  );
}

function lineTypeBackground(type: DiffLine["type"] | undefined | null) {
  if (!type) return styles.emptySplitCell;
  if (type === "add") return styles.addLineContainer;
  if (type === "remove") return styles.removeLineContainer;
  if (type === "header") return styles.headerLineContainer;
  return styles.contextLineContainer;
}

function wordHighlightStyle(type: DiffLine["type"] | undefined | null) {
  if (type === "add") return styles.addWordHighlight;
  if (type === "remove") return styles.removeWordHighlight;
  return undefined;
}

function DiffGutterCell({
  lineNumber,
  type,
  gutterWidth,
  textMetricsStyle,
  reviewTarget,
  reviewActions,
  isLineHovered,
  style,
  textTestID,
  actionTestID,
}: {
  lineNumber: number | null;
  type: DiffLine["type"] | undefined | null;
  gutterWidth: number;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  isLineHovered?: boolean;
  style?: StyleProp<ViewStyle>;
  textTestID?: string;
  actionTestID?: string;
}) {
  const lineHeight = getNumericLineHeight(textMetricsStyle);
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);
  const containerStyle = useMemo(
    () => [
      styles.gutterCell,
      lineTypeBackground(type),
      rowMetricsStyle,
      inlineUnistylesStyle({ width: gutterWidth }),
      style,
    ],
    [type, rowMetricsStyle, gutterWidth, style],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.lineNumberText,
      type === "add" && styles.addLineNumberText,
      type === "remove" && styles.removeLineNumberText,
    ],
    [textMetricsStyle, type],
  );
  const comments = useMemo(
    () =>
      reviewTarget
        ? (reviewActions?.commentsByTarget.get(reviewTarget.key) ?? EMPTY_COMMENTS)
        : EMPTY_COMMENTS,
    [reviewTarget, reviewActions?.commentsByTarget],
  );
  const isEditorOpen = isInlineReviewEditorForTarget(reviewActions?.editor ?? null, reviewTarget);
  const onStartComment = reviewActions?.onStartComment ?? noopStartComment;

  return (
    <InlineReviewGutterCell
      reviewTarget={reviewTarget}
      comments={comments}
      isEditorOpen={isEditorOpen}
      isLineHovered={isLineHovered}
      lineHeight={lineHeight}
      onStartComment={onStartComment}
      style={containerStyle}
      actionTestID={actionTestID}
    >
      <Text numberOfLines={1} style={textStyle} testID={textTestID}>
        {formatDiffGutterText(lineNumber)}
      </Text>
    </InlineReviewGutterCell>
  );
}

function DiffTextLine({
  line,
  changedRanges,
  wrapLines,
  textMetricsStyle,
  reviewTarget,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
  textTestID,
}: {
  line: DiffLine;
  changedRanges?: WordChangeRange[];
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
  textTestID?: string;
}) {
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line.type), rowMetricsStyle],
    [line.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, textMetricsStyle, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={onHoverChange}
      hoverTargetKey={hoverTargetKey}
      onHoverTargetChange={onHoverTargetChange}
      style={containerStyle}
    >
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
          testID={textTestID}
          changedRanges={changedRanges}
          changedHighlightStyle={wordHighlightStyle(line.type)}
        />
      ) : (
        <Text style={textStyle} testID={textTestID}>
          {formatDiffContentText(line.content)}
        </Text>
      )}
    </LongPressableLine>
  );
}

function SplitTextLine({
  line,
  wrapLines,
  textMetricsStyle,
  reviewActions,
  onHoverChange,
  hoverTargetKey,
  onHoverTargetChange,
}: {
  line: SplitDiffDisplayLine | null;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  onHoverChange?: (hovered: boolean) => void;
  hoverTargetKey?: string | null;
  onHoverTargetChange?: (key: string | null) => void;
}) {
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.textLineContainer, lineTypeBackground(line?.type), rowMetricsStyle],
    [line?.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, textMetricsStyle, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={line?.reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={onHoverChange}
      hoverTargetKey={hoverTargetKey}
      onHoverTargetChange={onHoverTargetChange}
      style={containerStyle}
    >
      {visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
          changedRanges={line?.changedRanges}
          changedHighlightStyle={wordHighlightStyle(line?.type)}
        />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line?.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function DiffLineView({
  line,
  changedRanges,
  lineNumber,
  gutterWidth,
  wrapLines,
  textMetricsStyle,
  reviewTarget,
  reviewActions,
}: {
  line: DiffLine;
  changedRanges?: WordChangeRange[];
  lineNumber: number | null;
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewTarget?: ReviewableDiffTarget | null;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line.type), rowMetricsStyle],
    [line.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line.type === "add" && styles.addLineText,
      line.type === "remove" && styles.removeLineText,
      line.type === "header" && styles.headerLineText,
      line.type === "context" && styles.contextLineText,
    ],
    [line.type, textMetricsStyle, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={setIsLineHovered}
      style={containerStyle}
    >
      <DiffGutterCell
        lineNumber={lineNumber}
        type={line.type}
        gutterWidth={gutterWidth}
        textMetricsStyle={textMetricsStyle}
        reviewTarget={reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {line.type !== "header" && visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
          changedRanges={changedRanges}
          changedHighlightStyle={wordHighlightStyle(line.type)}
        />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function SplitDiffLine({
  line,
  gutterWidth,
  wrapLines,
  textMetricsStyle,
  reviewActions,
}: {
  line: SplitDiffDisplayLine | null;
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
}) {
  const [isLineHovered, setIsLineHovered] = useState(false);
  const visibleTokens = line && hasVisibleDiffTokens(line.tokens) ? line.tokens : null;
  const rowMetricsStyle = useDiffRowMetricsStyle(textMetricsStyle);

  const containerStyle = useMemo(
    () => [styles.diffLineContainer, lineTypeBackground(line?.type), rowMetricsStyle],
    [line?.type, rowMetricsStyle],
  );
  const textStyle = useMemo(
    () => [
      styles.diffTextMetrics,
      textMetricsStyle,
      styles.diffLineText,
      getWrappedTextStyle(wrapLines),
      line?.type === "add" && styles.addLineText,
      line?.type === "remove" && styles.removeLineText,
      line?.type === "context" && styles.contextLineText,
      !line && styles.emptySplitCellText,
    ],
    [line, textMetricsStyle, wrapLines],
  );

  return (
    <LongPressableLine
      reviewTarget={line?.reviewTarget}
      reviewActions={reviewActions}
      onHoverChange={setIsLineHovered}
      style={containerStyle}
    >
      <DiffGutterCell
        lineNumber={line?.lineNumber ?? null}
        type={line?.type}
        gutterWidth={gutterWidth}
        textMetricsStyle={textMetricsStyle}
        reviewTarget={line?.reviewTarget}
        reviewActions={reviewActions}
        isLineHovered={isLineHovered}
        style={styles.lineNumberGutter}
      />
      {visibleTokens ? (
        <HighlightedText
          tokens={visibleTokens}
          textMetricsStyle={textMetricsStyle}
          wrapLines={wrapLines}
          changedRanges={line?.changedRanges}
          changedHighlightStyle={wordHighlightStyle(line?.type)}
        />
      ) : (
        <Text style={textStyle}>{formatDiffContentText(line?.content)}</Text>
      )}
    </LongPressableLine>
  );
}

function InlineReviewThreadContent({
  reviewTarget,
  reviewActions,
  reservedHeight,
  viewportWidth,
  pinToViewport,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  reservedHeight?: number;
  viewportWidth?: number;
  pinToViewport?: boolean;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const placeholderStyle = useMemo<ViewStyle>(
    () => inlineUnistylesStyle({ minHeight: height }),
    [height],
  );
  if (height === 0) {
    return null;
  }
  if (!reviewTarget || !reviewActions || !threadState) {
    return <View style={placeholderStyle} />;
  }

  return (
    <InlineReviewThread
      reviewTarget={reviewTarget}
      reviewActions={reviewActions}
      height={height}
      viewportWidth={viewportWidth}
      pinToViewport={pinToViewport}
      testID={`review-thread-${reviewTarget.key}`}
    />
  );
}

function InlineReviewGutterSpacer({
  reviewTarget,
  reviewActions,
  gutterWidth,
  reservedHeight,
  style,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  gutterWidth: number;
  reservedHeight?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const spacerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.inlineReviewGutterSpacer,
      inlineUnistylesStyle({ width: gutterWidth, minHeight: height }),
      style,
    ],
    [gutterWidth, height, style],
  );
  if (height === 0) {
    return null;
  }

  return <View style={spacerStyle} />;
}

function InlineReviewRow({
  reviewTarget,
  reviewActions,
  gutterWidth,
  reservedHeight,
}: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
  gutterWidth: number;
  reservedHeight?: number;
}) {
  const threadState = getInlineReviewThreadState({ reviewTarget, reviewActions });
  const height = reservedHeight ?? threadState?.height ?? 0;
  const gutterSpacerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.inlineReviewGutterSpacer, inlineUnistylesStyle({ width: gutterWidth })],
    [gutterWidth],
  );
  const placeholderStyle = useMemo<ViewStyle>(
    () => inlineUnistylesStyle({ minHeight: height }),
    [height],
  );
  if (height === 0) {
    return null;
  }

  return (
    <View style={styles.inlineReviewRow}>
      <View style={gutterSpacerStyle} />
      {reviewTarget && reviewActions && threadState ? (
        <InlineReviewThread
          reviewTarget={reviewTarget}
          reviewActions={reviewActions}
          height={height}
          testID={`review-thread-${reviewTarget.key}`}
        />
      ) : (
        <View style={placeholderStyle} />
      )}
    </View>
  );
}

function SplitDiffColumn({
  rows,
  side,
  gutterWidth,
  wrapLines,
  textMetricsStyle,
  reviewActions,
  showDivider = false,
}: {
  rows: SplitDiffRow[];
  side: "left" | "right";
  gutterWidth: number;
  wrapLines: boolean;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  showDivider?: boolean;
}) {
  const [scrollWidth, setScrollWidth] = useState(0);
  const [hoveredReviewTargetKey, setHoveredReviewTargetKey] = useState<string | null>(null);

  const wrapCellStyle = useMemo(
    () => [styles.splitCell, showDivider && styles.splitCellWithDivider],
    [showDivider],
  );
  const rowCellStyle = useMemo(
    () => [styles.splitCell, showDivider && styles.splitCellWithDivider, styles.splitCellRow],
    [showDivider],
  );
  const linesContainerRowStyle = useMemo(
    () => [
      styles.linesContainer,
      scrollWidth > 0 && inlineUnistylesStyle({ minWidth: scrollWidth }),
    ],
    [scrollWidth],
  );
  const headerLineTextStyle = useMemo(
    () => [styles.diffTextMetrics, textMetricsStyle, styles.diffLineText, styles.headerLineText],
    [textMetricsStyle],
  );

  const keyedRows = useMemo(() => rows.map((row, i) => ({ key: `row-${i}`, row })), [rows]);

  if (wrapLines) {
    return (
      <View style={wrapCellStyle}>
        <View style={styles.linesContainer}>
          {keyedRows.map(({ key, row }) => {
            if (row.kind === "header") {
              return (
                <View key={key} style={styles.splitHeaderRow}>
                  <Text style={headerLineTextStyle}>{row.content}</Text>
                </View>
              );
            }
            const line = side === "left" ? row.left : row.right;
            const reviewRowState = getSplitInlineReviewThreadState({
              left: row.left?.reviewTarget,
              right: row.right?.reviewTarget,
              reviewActions,
            });
            return (
              <View key={key}>
                <SplitDiffLine
                  line={line}
                  gutterWidth={gutterWidth}
                  wrapLines={wrapLines}
                  textMetricsStyle={textMetricsStyle}
                  reviewActions={reviewActions}
                />
                <InlineReviewRow
                  reviewTarget={line?.reviewTarget}
                  reviewActions={reviewActions}
                  gutterWidth={gutterWidth}
                  reservedHeight={reviewRowState?.height}
                />
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View style={rowCellStyle}>
      <View style={styles.gutterColumn}>
        {keyedRows.map(({ key, row }) => {
          if (row.kind === "header") {
            return (
              <DiffGutterCell
                key={key}
                lineNumber={null}
                type="header"
                gutterWidth={gutterWidth}
                textMetricsStyle={textMetricsStyle}
              />
            );
          }
          const line = side === "left" ? row.left : row.right;
          const reviewTargetKey = line?.reviewTarget?.key ?? null;
          const reviewRowState = getSplitInlineReviewThreadState({
            left: row.left?.reviewTarget,
            right: row.right?.reviewTarget,
            reviewActions,
          });
          return (
            <View key={key}>
              <DiffGutterCell
                lineNumber={line?.lineNumber ?? null}
                type={line?.type}
                gutterWidth={gutterWidth}
                textMetricsStyle={textMetricsStyle}
                reviewTarget={line?.reviewTarget}
                reviewActions={reviewActions}
                isLineHovered={
                  reviewTargetKey !== null && hoveredReviewTargetKey === reviewTargetKey
                }
              />
              <InlineReviewGutterSpacer
                reviewTarget={line?.reviewTarget}
                reviewActions={reviewActions}
                gutterWidth={gutterWidth}
                reservedHeight={reviewRowState?.height}
              />
            </View>
          );
        })}
      </View>
      <DiffScroll
        scrollViewWidth={scrollWidth}
        onScrollViewWidthChange={setScrollWidth}
        style={styles.splitColumnScroll}
        contentContainerStyle={styles.diffContentInner}
      >
        <View style={linesContainerRowStyle}>
          {keyedRows.map(({ key, row }) => {
            if (row.kind === "header") {
              return (
                <View key={key} style={styles.splitHeaderRow}>
                  <Text style={headerLineTextStyle}>{row.content}</Text>
                </View>
              );
            }
            const line = side === "left" ? row.left : row.right;
            const reviewTargetKey = line?.reviewTarget?.key ?? null;
            const reviewRowState = getSplitInlineReviewThreadState({
              left: row.left?.reviewTarget,
              right: row.right?.reviewTarget,
              reviewActions,
            });
            return (
              <View key={key}>
                <SplitTextLine
                  line={line}
                  wrapLines={false}
                  textMetricsStyle={textMetricsStyle}
                  reviewActions={reviewActions}
                  hoverTargetKey={reviewTargetKey}
                  onHoverTargetChange={setHoveredReviewTargetKey}
                />
                <InlineReviewThreadContent
                  reviewTarget={line?.reviewTarget}
                  reviewActions={reviewActions}
                  reservedHeight={reviewRowState?.height}
                  viewportWidth={scrollWidth}
                  pinToViewport
                />
              </View>
            );
          })}
        </View>
      </DiffScroll>
    </View>
  );
}

const DiffFileHeader = memo(function DiffFileHeader({
  file,
  isExpanded,
  depth = 0,
  showDir = true,
  interactive = true,
  onToggle,
  onHeaderHeightChange,
  testID,
  activeDiffTool,
}: DiffFileSectionProps) {
  const { t } = useTranslation();
  const layoutYRef = useRef<number | null>(null);
  const pressHandledRef = useRef(false);
  const pressInRef = useRef<{ ts: number; pageX: number; pageY: number } | null>(null);

  const toggleExpanded = useCallback(() => {
    if (!interactive) {
      return;
    }
    pressHandledRef.current = true;
    onToggle?.(file.path);
  }, [file.path, interactive, onToggle]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      layoutYRef.current = event.nativeEvent.layout.y;
      onHeaderHeightChange?.(file.path, event.nativeEvent.layout.height);
    },
    [file.path, onHeaderHeightChange],
  );

  const handlePressIn = useCallback((event: { nativeEvent: { pageX: number; pageY: number } }) => {
    pressHandledRef.current = false;
    pressInRef.current = {
      ts: Date.now(),
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  }, []);

  const handlePressOut = useCallback(
    (event: { nativeEvent: { pageX: number; pageY: number } }) => {
      if (
        interactive &&
        isNative &&
        !pressHandledRef.current &&
        layoutYRef.current === 0 &&
        pressInRef.current
      ) {
        const durationMs = Date.now() - pressInRef.current.ts;
        const dx = event.nativeEvent.pageX - pressInRef.current.pageX;
        const dy = event.nativeEvent.pageY - pressInRef.current.pageY;
        const distance = Math.hypot(dx, dy);
        if (durationMs <= 500 && distance <= 12) {
          toggleExpanded();
        }
      }
    },
    [interactive, toggleExpanded],
  );

  const containerStyle = useMemo(
    () => [styles.fileSectionHeaderContainer, isExpanded && styles.fileSectionHeaderExpanded],
    [isExpanded],
  );

  const headerPressableStyle = useCallback(
    (state: PressableStateCallbackType) =>
      depth > 0
        ? [
            fileHeaderPressableStyle(state),
            inlineUnistylesStyle({ paddingLeft: treeRowPaddingLeft(depth) }),
          ]
        : fileHeaderPressableStyle(state),
    [depth],
  );

  const fileName = file.path.split("/").pop() ?? file.path;
  const headerContent = (
    <>
      <View style={styles.fileHeaderLeft}>
        {showDir ? null : (
          <View style={styles.fileIcon}>
            <SvgXml xml={getFileIconSvg(fileName)} width={16} height={16} />
          </View>
        )}
        <Text style={styles.fileName} numberOfLines={1}>
          {fileName}
        </Text>
        {showDir ? (
          <Text style={styles.fileDir} numberOfLines={1}>
            {file.path.includes("/") ? ` ${file.path.slice(0, file.path.lastIndexOf("/"))}` : ""}
          </Text>
        ) : (
          // Flex spacer in tree mode (no dir suffix) so the New/Deleted badge
          // stays right-aligned next to the diff stats, as in the flat list.
          <View style={styles.fileDirSpacer} />
        )}
        {file.isNew && (
          <View style={styles.newBadge}>
            <Text style={styles.newBadgeText}>{t("workspace.git.diff.newFile")}</Text>
          </View>
        )}
        {file.isDeleted && (
          <View style={styles.deletedBadge}>
            <Text style={styles.deletedBadgeText}>{t("workspace.git.diff.deletedFile")}</Text>
          </View>
        )}
        {file.diffTool === "git" && activeDiffTool && activeDiffTool !== "git" && (
          <View style={styles.lineDiffBadge}>
            <Text style={styles.lineDiffBadgeText}>{t("workspace.git.diff.lineDiffBadge")}</Text>
          </View>
        )}
      </View>
      <View style={styles.fileHeaderRight}>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </View>
    </>
  );

  return (
    <View style={containerStyle} onLayout={handleLayout} testID={testID}>
      <TreeIndentGuides depth={depth} />
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          {interactive ? (
            <Pressable
              testID={testID ? `${testID}-toggle` : undefined}
              style={headerPressableStyle}
              // Android: prevent parent pan/scroll gestures from canceling the tap release.
              cancelable={false}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              onPress={toggleExpanded}
            >
              {headerContent}
            </Pressable>
          ) : (
            <View style={headerPressableStyle({ hovered: false, pressed: false })}>
              {headerContent}
            </View>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" offset={6} maxWidth={520}>
          <Text style={styles.tooltipText}>{file.path}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
});

export function DiffFileBody({
  file,
  layout,
  wrapLines,
  codeFontSize,
  textMetricsStyle,
  reviewActions,
  onBodyHeightChange,
  testID,
}: {
  file: ParsedDiffFile;
  layout: "unified" | "split";
  wrapLines: boolean;
  codeFontSize: number;
  textMetricsStyle: TextStyle;
  reviewActions?: InlineReviewActions;
  onBodyHeightChange?: (file: ParsedDiffFile, height: number) => void;
  testID?: string;
}) {
  const [scrollViewWidth, setScrollViewWidth] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [hoveredReviewTargetKey, setHoveredReviewTargetKey] = useState<string | null>(null);
  const { t } = useTranslation();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setBodyWidth(event.nativeEvent.layout.width);
      onBodyHeightChange?.(file, event.nativeEvent.layout.height);
    },
    [file, onBodyHeightChange],
  );

  const availableWidth = bodyWidth > 0 ? bodyWidth : scrollViewWidth;
  const linesContainerRowStyle = useMemo(
    () => [
      styles.linesContainer,
      availableWidth > 0 && inlineUnistylesStyle({ minWidth: availableWidth }),
    ],
    [availableWidth],
  );

  return (
    <View
      style={[styles.fileSectionBodyContainer, styles.fileSectionBorder]}
      onLayout={handleLayout}
      testID={testID}
    >
      {(() => {
        if (file.status === "too_large" || file.status === "binary") {
          return (
            <View style={styles.statusMessageContainer}>
              <Text style={styles.statusMessageText}>
                {file.status === "binary"
                  ? t("workspace.git.diff.binaryFile")
                  : t("workspace.git.diff.tooLarge")}
              </Text>
            </View>
          );
        }

        let maxLineNo = 0;
        for (const hunk of file.hunks) {
          maxLineNo = Math.max(
            maxLineNo,
            hunk.oldStart + hunk.oldCount,
            hunk.newStart + hunk.newCount,
          );
        }
        const gutterWidth = lineNumberGutterWidth(maxLineNo, codeFontSize);

        if (layout === "split") {
          const rows = buildSplitDiffRows(file);
          return (
            <View style={[styles.diffContent, styles.splitRow]} dataSet={CODE_SURFACE_DATASET}>
              <SplitDiffColumn
                rows={rows}
                side="left"
                gutterWidth={gutterWidth}
                wrapLines={wrapLines}
                textMetricsStyle={textMetricsStyle}
                reviewActions={reviewActions}
              />
              <SplitDiffColumn
                rows={rows}
                side="right"
                gutterWidth={gutterWidth}
                wrapLines={wrapLines}
                textMetricsStyle={textMetricsStyle}
                reviewActions={reviewActions}
                showDivider
              />
            </View>
          );
        }

        const computedLines = buildUnifiedDiffLines(file);

        if (wrapLines) {
          return (
            <View style={styles.diffContent} dataSet={CODE_SURFACE_DATASET}>
              <View style={styles.linesContainer}>
                {computedLines.map(
                  ({ line, changedRanges, lineNumber, key, reviewTarget }, index) => (
                    <View key={key} testID={`diff-wrapped-row-${index}`}>
                      <DiffLineView
                        line={line}
                        changedRanges={changedRanges}
                        lineNumber={lineNumber}
                        gutterWidth={gutterWidth}
                        wrapLines={wrapLines}
                        textMetricsStyle={textMetricsStyle}
                        reviewTarget={reviewTarget}
                        reviewActions={reviewActions}
                      />
                      <InlineReviewRow
                        reviewTarget={reviewTarget}
                        reviewActions={reviewActions}
                        gutterWidth={gutterWidth}
                      />
                    </View>
                  ),
                )}
              </View>
            </View>
          );
        }

        const textViewportWidth =
          scrollViewWidth > 0 ? scrollViewWidth : Math.max(0, bodyWidth - gutterWidth);
        return (
          <View style={[styles.diffContent, styles.diffContentRow]} dataSet={CODE_SURFACE_DATASET}>
            <View style={styles.gutterColumn}>
              {computedLines.map(({ line, lineNumber, key, reviewTarget }, index) => (
                <View key={key} testID={`diff-gutter-row-${index}`}>
                  <DiffGutterCell
                    lineNumber={lineNumber}
                    type={line.type}
                    gutterWidth={gutterWidth}
                    textMetricsStyle={textMetricsStyle}
                    reviewTarget={reviewTarget}
                    reviewActions={reviewActions}
                    isLineHovered={
                      reviewTarget?.key !== undefined && hoveredReviewTargetKey === reviewTarget.key
                    }
                    textTestID={`diff-gutter-text-${index}`}
                    actionTestID={`diff-gutter-action-${index}`}
                  />
                  <InlineReviewGutterSpacer
                    reviewTarget={reviewTarget}
                    reviewActions={reviewActions}
                    gutterWidth={gutterWidth}
                  />
                </View>
              ))}
            </View>
            <DiffScroll
              scrollViewWidth={scrollViewWidth}
              onScrollViewWidthChange={setScrollViewWidth}
              style={styles.splitColumnScroll}
              contentContainerStyle={styles.diffContentInner}
            >
              <View style={linesContainerRowStyle}>
                {computedLines.map(({ line, changedRanges, key, reviewTarget }, index) => (
                  <View key={key} testID={`diff-code-row-${index}`}>
                    <DiffTextLine
                      line={line}
                      changedRanges={changedRanges}
                      wrapLines={false}
                      textMetricsStyle={textMetricsStyle}
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                      hoverTargetKey={reviewTarget?.key ?? null}
                      onHoverTargetChange={setHoveredReviewTargetKey}
                      textTestID={`diff-code-text-${index}`}
                    />
                    <InlineReviewThreadContent
                      reviewTarget={reviewTarget}
                      reviewActions={reviewActions}
                      viewportWidth={textViewportWidth}
                      pinToViewport
                    />
                  </View>
                ))}
              </View>
            </DiffScroll>
          </View>
        );
      })()}
    </View>
  );
}

interface GitDiffPaneProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  enabled?: boolean;
}

// Arbitrary branch/ref compare state (mode "refs" — see the "Compare with branch…" picker).
// toRef undefined means HEAD; mergeBase true means "only changes on this branch" (fromRef's
// merge-base with toRef), false means a full two-point diff.
interface BranchCompareState {
  fromRef: string;
  toRef?: string;
  mergeBase: boolean;
}

type PressableStyleFn = (
  state: PressableStateCallbackType & { hovered?: boolean; open?: boolean },
) => StyleProp<ViewStyle>;

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedAlignJustify = withUnistyles(AlignJustify);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedPilcrow = withUnistyles(Pilcrow);
const ThemedWrapText = withUnistyles(WrapText);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedList = withUnistyles(List);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);
const ThemedDownload = withUnistyles(Download);
const ThemedUpload = withUnistyles(Upload);
const ThemedArrowDownUp = withUnistyles(ArrowDownUp);
const ThemedGitMerge = withUnistyles(GitMerge);
const ThemedRefreshCcw = withUnistyles(RefreshCcw);
const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);

const DIFF_OPTIONS_WHITESPACE_ICON = (
  <ThemedPilcrow size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_WRAP_ICON = (
  <ThemedWrapText size={14} uniProps={foregroundMutedIconColorMapping} />
);

interface DiffLayoutToggleProps {
  layout: "unified" | "split";
  isMobile: boolean;
  toggleStyle: PressableStyleFn;
  onToggle: () => void;
}

function DiffLayoutToggle({ layout, isMobile, toggleStyle, onToggle }: DiffLayoutToggleProps) {
  const { t } = useTranslation();
  const label =
    layout === "unified"
      ? t("workspace.git.diff.switchToSplit")
      : t("workspace.git.diff.switchToUnified");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="changes-toggle-layout"
          onPress={onToggle}
          style={toggleStyle}
        >
          {layout === "unified" ? (
            <ThemedColumns2 size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          ) : (
            <ThemedAlignJustify
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffViewModeToggleProps {
  viewMode: "flat" | "tree";
  isMobile: boolean;
  toggleStyle: PressableStyleFn;
  onToggle: () => void;
}

function DiffViewModeToggle({
  viewMode,
  isMobile,
  toggleStyle,
  onToggle,
}: DiffViewModeToggleProps) {
  const { t } = useTranslation();
  const label =
    viewMode === "flat"
      ? t("workspace.git.diff.showTreeView")
      : t("workspace.git.diff.showFlatView");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="changes-toggle-view-mode"
          style={toggleStyle}
          onPress={onToggle}
        >
          {viewMode === "flat" ? (
            <ThemedFolderTree
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          ) : (
            <ThemedList size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface DiffFilesToolbarProps {
  allFileDiffsExpanded: boolean;
  isMobile: boolean;
  expandAllToggleStyle: PressableStyleFn;
  onToggleExpandAll: () => void;
}

function DiffFilesToolbar({
  allFileDiffsExpanded,
  isMobile,
  expandAllToggleStyle,
  onToggleExpandAll,
}: DiffFilesToolbarProps) {
  const { t } = useTranslation();
  const expandAllLabel = allFileDiffsExpanded
    ? t("workspace.git.diff.collapseAll")
    : t("workspace.git.diff.expandAll");
  return (
    <View style={styles.diffStatusButtons}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expandAllLabel}
            style={expandAllToggleStyle}
            onPress={onToggleExpandAll}
          >
            {allFileDiffsExpanded ? (
              <ThemedListChevronsDownUp
                size={isMobile ? 18 : 14}
                uniProps={foregroundMutedIconColorMapping}
              />
            ) : (
              <ThemedListChevronsUpDown
                size={isMobile ? 18 : 14}
                uniProps={foregroundMutedIconColorMapping}
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{expandAllLabel}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function diffFontSizeLabel(t: TFunction, step: DiffFontSizeStep): string {
  if (step === "xs") return t("workspace.git.diff.textSizeXs");
  if (step === "sm") return t("workspace.git.diff.textSizeSm");
  if (step === "lg") return t("workspace.git.diff.textSizeLg");
  if (step === "xl") return t("workspace.git.diff.textSizeXl");
  if (step === "xxl") return t("workspace.git.diff.textSizeXxl");
  if (step === "xxxl") return t("workspace.git.diff.textSizeXxxl");
  return t("workspace.git.diff.textSizeMd");
}

interface DiffFontSizeMenuItemProps {
  step: DiffFontSizeStep;
  selected: boolean;
  onSelectDiffFontSize: (step: DiffFontSizeStep) => void;
}

// Split out so each item's onSelect is a stable callback instead of a fresh arrow per
// render inside DIFF_FONT_SIZE_STEPS.map (jsx-no-new-function-as-prop). The menu stays
// open on select (closeOnSelect={false}) so the user can step through sizes and watch
// the diff re-render live.
function DiffFontSizeMenuItem({ step, selected, onSelectDiffFontSize }: DiffFontSizeMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelectDiffFontSize(step), [step, onSelectDiffFontSize]);
  return (
    <DropdownMenuItem
      testID={`changes-diff-font-size-${step}`}
      selected={selected}
      closeOnSelect={false}
      onSelect={handleSelect}
    >
      {diffFontSizeLabel(t, step)}
    </DropdownMenuItem>
  );
}

interface DiffOptionsMenuProps {
  brand: string;
  diffFontSize: DiffFontSizeStep;
  hideWhitespace: boolean;
  isMobile: boolean;
  isRefreshing: boolean;
  overflowToggleStyle: PressableStyleFn;
  refreshSupported: boolean;
  wrapLines: boolean;
  onRefresh: () => void;
  onSelectDiffFontSize: (step: DiffFontSizeStep) => void;
  onToggleHideWhitespace: () => void;
  onToggleWrapLines: () => void;
}

function DiffOptionsMenu({
  brand,
  diffFontSize,
  hideWhitespace,
  isMobile,
  isRefreshing,
  overflowToggleStyle,
  refreshSupported,
  wrapLines,
  onRefresh,
  onSelectDiffFontSize,
  onToggleHideWhitespace,
  onToggleWrapLines,
}: DiffOptionsMenuProps) {
  const { t } = useTranslation();
  const whitespaceLabel = hideWhitespace
    ? t("workspace.git.diff.showWhitespace")
    : t("workspace.git.diff.hideWhitespace");
  const wrapLinesLabel = wrapLines
    ? t("workspace.git.diff.scrollLongLines")
    : t("workspace.git.diff.wrapLongLines");
  const optionsLabel = t("workspace.git.diff.options");
  const refreshIcon = useMemo(
    () =>
      isRefreshing ? (
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ) : (
        <ThemedRotateCw size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ),
    [isRefreshing],
  );

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={optionsLabel}
            testID="changes-options-menu"
            style={overflowToggleStyle}
          >
            <ThemedChevronDown
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{optionsLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" width={240} testID="changes-options-menu-content">
        <DropdownMenuItem
          leading={DIFF_OPTIONS_WHITESPACE_ICON}
          selected={hideWhitespace}
          testID="changes-toggle-whitespace"
          onSelect={onToggleHideWhitespace}
        >
          {whitespaceLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={DIFF_OPTIONS_WRAP_ICON}
          selected={wrapLines}
          testID="changes-toggle-wrap-lines"
          onSelect={onToggleWrapLines}
        >
          {wrapLinesLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel testID="changes-diff-font-size-label">
          {t("workspace.git.diff.textSize")}
        </DropdownMenuLabel>
        {DIFF_FONT_SIZE_STEPS.map((step) => (
          <DiffFontSizeMenuItem
            key={step}
            step={step}
            selected={diffFontSize === step}
            onSelectDiffFontSize={onSelectDiffFontSize}
          />
        ))}
        {refreshSupported ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              leading={refreshIcon}
              disabled={isRefreshing}
              testID="changes-refresh"
              onSelect={onRefresh}
            >
              {isRefreshing
                ? t("workspace.git.diff.refreshing")
                : t("workspace.git.diff.refreshState", {
                    brand,
                  })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const GIT_ALGORITHMS: readonly GitDiffAlgorithm[] = ["histogram", "myers", "patience"];

function diffToolLabel(t: TFunction, tool: DiffToolId): string {
  if (tool === "vscode") return t("workspace.git.diff.engineVscode");
  if (tool === "difftastic") return t("workspace.git.diff.engineDifftastic");
  return t("workspace.git.diff.engineGit");
}

function gitAlgorithmLabel(t: TFunction, algorithm: GitDiffAlgorithm): string {
  if (algorithm === "myers") return t("workspace.git.diff.algorithmMyers");
  if (algorithm === "patience") return t("workspace.git.diff.algorithmPatience");
  return t("workspace.git.diff.algorithmHistogram");
}

function difftasticMenuItemLabel(
  t: TFunction,
  difftasticState: ServerDiffToolsCapability["difftastic"] | null,
  isInstallBusy: boolean,
): string {
  if (difftasticState !== "installable") {
    return t("workspace.git.diff.engineDifftastic");
  }
  return isInstallBusy
    ? t("workspace.git.diff.installingDifftastic")
    : t("workspace.git.diff.installDifftastic");
}

interface GitAlgorithmMenuItemProps {
  algorithm: GitDiffAlgorithm;
  selected: boolean;
  onSelectGitAlgorithm: (algorithm: GitDiffAlgorithm) => void;
}

// Split out so each item's onSelect is a stable callback instead of a fresh arrow per
// render inside GIT_ALGORITHMS.map (jsx-no-new-function-as-prop).
function GitAlgorithmMenuItem({
  algorithm,
  selected,
  onSelectGitAlgorithm,
}: GitAlgorithmMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => onSelectGitAlgorithm(algorithm),
    [algorithm, onSelectGitAlgorithm],
  );
  return (
    <DropdownMenuItem
      testID={`changes-diff-engine-algorithm-${algorithm}`}
      selected={selected}
      onSelect={handleSelect}
    >
      {gitAlgorithmLabel(t, algorithm)}
    </DropdownMenuItem>
  );
}

// Install progress phases that should read as "busy" on the menu item (spinner + disabled).
const DIFFTASTIC_INSTALL_BUSY_PHASES: ReadonlySet<InstallDifftasticStatus> = new Set([
  "starting",
  "downloading",
  "verifying",
  "installing",
]);

interface DiffEngineMenuProps {
  diffTool: DiffToolId;
  // Raw persisted algorithm choice — undefined until the user picks one. No item is shown
  // as checked in that case: git's own default (myers) applies server-side.
  gitAlgorithm: GitDiffAlgorithm | undefined;
  triggerStyle: PressableStyleFn;
  // null on servers that predate the diffTools capability (COMPAT) — non-git engines are
  // hidden entirely in that case rather than shown as unavailable.
  diffToolsCapability: ServerDiffToolsCapability | null;
  installStatus: InstallDifftasticStatus;
  installError: string | null;
  onSelectTool: (tool: DiffToolId) => void;
  onSelectGitAlgorithm: (algorithm: GitDiffAlgorithm) => void;
  onInstallDifftastic: () => void;
}

function DiffEngineMenu({
  diffTool,
  gitAlgorithm,
  triggerStyle,
  diffToolsCapability,
  installStatus,
  installError,
  onSelectTool,
  onSelectGitAlgorithm,
  onInstallDifftastic,
}: DiffEngineMenuProps) {
  const { t } = useTranslation();
  const engineLabel = t("workspace.git.diff.engine");
  const isInstallBusy = DIFFTASTIC_INSTALL_BUSY_PHASES.has(installStatus);
  const difftasticState = diffToolsCapability?.difftastic ?? null;

  const handleSelectGit = useCallback(() => onSelectTool("git"), [onSelectTool]);
  const handleSelectVscode = useCallback(() => onSelectTool("vscode"), [onSelectTool]);
  const handleSelectDifftastic = useCallback(() => {
    if (difftasticState === "installable") {
      onInstallDifftastic();
      return;
    }
    onSelectTool("difftastic");
  }, [difftasticState, onInstallDifftastic, onSelectTool]);

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            style={triggerStyle}
            testID="changes-diff-engine"
            accessibilityRole="button"
            accessibilityLabel={engineLabel}
          >
            <Text style={styles.diffStatusText} numberOfLines={1}>
              {diffToolLabel(t, diffTool)}
            </Text>
            <ThemedChevronDown size={12} uniProps={foregroundMutedIconColorMapping} />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{engineLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" width={260} testID="changes-diff-engine-menu">
        <DropdownMenuItem
          testID="changes-diff-engine-git"
          selected={diffTool === "git"}
          onSelect={handleSelectGit}
        >
          {t("workspace.git.diff.engineGit")}
        </DropdownMenuItem>
        <DropdownMenuLabel testID="changes-diff-engine-algorithm-label">
          {t("workspace.git.diff.algorithm")}
        </DropdownMenuLabel>
        {GIT_ALGORITHMS.map((algorithm) => (
          <GitAlgorithmMenuItem
            key={algorithm}
            algorithm={algorithm}
            selected={gitAlgorithm === algorithm}
            onSelectGitAlgorithm={onSelectGitAlgorithm}
          />
        ))}
        {diffToolsCapability ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              testID="changes-diff-engine-vscode"
              selected={diffTool === "vscode"}
              onSelect={handleSelectVscode}
            >
              {t("workspace.git.diff.engineVscode")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID="changes-diff-engine-difftastic"
              selected={diffTool === "difftastic" && difftasticState === "available"}
              disabled={difftasticState === "unavailable" || isInstallBusy}
              status={isInstallBusy ? "pending" : undefined}
              closeOnSelect={difftasticState !== "installable"}
              tooltip={
                difftasticState === "unavailable"
                  ? t("workspace.git.diff.difftasticUnavailable")
                  : (installError ?? undefined)
              }
              onSelect={handleSelectDifftastic}
            >
              {difftasticMenuItemLabel(t, difftasticState, isInstallBusy)}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function branchCompareMergeBaseLabel(t: TFunction, mergeBase: boolean): string {
  return mergeBase ? t("workspace.git.diff.onlyChangesOnBranch") : t("workspace.git.diff.fullDiff");
}

interface BranchCompareAdvancedControlsProps {
  branchCompare: BranchCompareState | null;
  branchCompareToLabel: string | null;
  toggleStyle: PressableStyleFn;
  onOpenToRef: () => void;
  onSwap: () => void;
  onToggleMergeBase: () => void;
}

// The "against ref" / swap / merge-base row shown only while a branch compare is active.
// Split out so its own conditional rendering + labels don't count against GitDiffPane's
// complexity budget (it was already dense before this feature landed).
function BranchCompareAdvancedControls({
  branchCompare,
  branchCompareToLabel,
  toggleStyle,
  onOpenToRef,
  onSwap,
  onToggleMergeBase,
}: BranchCompareAdvancedControlsProps) {
  const { t } = useTranslation();
  if (!branchCompare) {
    return null;
  }
  const mergeBaseLabel = branchCompareMergeBaseLabel(t, branchCompare.mergeBase);
  return (
    <View style={styles.diffStatusButtons}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("workspace.git.diff.compareAgainstRef")}
        style={toggleStyle}
        onPress={onOpenToRef}
        testID="changes-branch-compare-to-ref"
      >
        <Text style={styles.diffStatusText} numberOfLines={1}>
          {branchCompareToLabel}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("workspace.git.diff.swapRefs")}
        style={toggleStyle}
        onPress={onSwap}
        testID="changes-branch-compare-swap"
      >
        <ThemedArrowDownUp size={14} uniProps={foregroundMutedIconColorMapping} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={mergeBaseLabel}
        style={toggleStyle}
        onPress={onToggleMergeBase}
        testID="changes-branch-compare-merge-base"
      >
        <Text style={styles.diffStatusText} numberOfLines={1}>
          {mergeBaseLabel}
        </Text>
      </Pressable>
    </View>
  );
}

type DiffFlatItemLayoutGetter = NonNullable<FlatListProps<DiffFlatItem>["getItemLayout"]>;
const EMPTY_PATH_LIST: string[] = [];

function getUnifiedDiffLineCount(file: ParsedDiffFile): number {
  let lineCount = 0;
  for (const hunk of file.hunks) {
    lineCount += hunk.lines.length;
  }
  return lineCount;
}

function getDiffContentLength(file: ParsedDiffFile): number {
  let contentLength = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      contentLength += line.content.length;
    }
  }
  return contentLength;
}

function computeEmptyMessage(
  hideWhitespace: boolean,
  diffMode: "uncommitted" | "base",
  baseRefLabel: string,
  labels: {
    hiddenWhitespace: string;
    uncommitted: string;
    againstBase: (baseRefLabel: string) => string;
  },
): string {
  if (hideWhitespace) {
    return labels.hiddenWhitespace;
  }
  if (diffMode === "uncommitted") {
    return labels.uncommitted;
  }
  return labels.againstBase(baseRefLabel);
}

interface DiffBodyContentProps {
  isStatusLoading: boolean;
  statusErrorMessage: string | null;
  notGit: boolean;
  isDiffLoading: boolean;
  diffErrorMessage: string | null;
  diffErrorCode: string | null;
  baseReselectSlot: ReactElement | null;
  hasChanges: boolean;
  emptyMessage: string;
  flatItems: DiffFlatItem[];
  stickyHeaderIndices: number[];
  renderFlatItem: ({ item }: { item: DiffFlatItem }) => ReactElement;
  flatKeyExtractor: (item: DiffFlatItem) => string;
  getFlatItemLayout: DiffFlatItemLayoutGetter;
  flatExtraData: unknown;
  diffListRef: RefObject<FlatList<DiffFlatItem> | null>;
  handleDiffListLayout: (event: LayoutChangeEvent) => void;
  handleDiffListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: (width: number, height: number) => void;
  showDesktopWebScrollbar: boolean;
  checkingRepositoryLabel: string;
  notRepositoryLabel: string;
  diffEmptyTextStyle: TextStyle;
  diffMessageTextStyle: TextStyle;
}

function DiffBodyContent({
  isStatusLoading,
  statusErrorMessage,
  notGit,
  isDiffLoading,
  diffErrorMessage,
  diffErrorCode,
  baseReselectSlot,
  hasChanges,
  emptyMessage,
  flatItems,
  stickyHeaderIndices,
  renderFlatItem,
  flatKeyExtractor,
  getFlatItemLayout,
  flatExtraData,
  diffListRef,
  handleDiffListLayout,
  handleDiffListScroll,
  onContentSizeChange,
  showDesktopWebScrollbar,
  checkingRepositoryLabel,
  notRepositoryLabel,
  diffEmptyTextStyle,
  diffMessageTextStyle,
}: DiffBodyContentProps) {
  const loadingTextStyle = useMemo(
    () => [styles.loadingText, diffMessageTextStyle],
    [diffMessageTextStyle],
  );
  const errorTextStyle = useMemo(
    () => [styles.errorText, diffMessageTextStyle],
    [diffMessageTextStyle],
  );
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, diffEmptyTextStyle],
    [diffEmptyTextStyle],
  );
  if (isStatusLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedActivityIndicator size="large" uniProps={foregroundMutedIconColorMapping} />
        <Text style={loadingTextStyle}>{checkingRepositoryLabel}</Text>
      </View>
    );
  }
  if (statusErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={errorTextStyle}>{statusErrorMessage}</Text>
      </View>
    );
  }
  if (notGit) {
    return (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={emptyTextStyle}>{notRepositoryLabel}</Text>
      </View>
    );
  }
  if (isDiffLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedActivityIndicator size="large" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }
  if (diffErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={errorTextStyle}>{diffErrorMessage}</Text>
        {diffErrorCode === "BASE_REF_NOT_FOUND" ? baseReselectSlot : null}
      </View>
    );
  }
  if (!hasChanges) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={emptyTextStyle}>{emptyMessage}</Text>
      </View>
    );
  }
  return children;
}

interface SharedDiffViewProps {
  files: ParsedDiffFile[];
  displayPreferences: {
    layout: "unified" | "split";
    wrapLines: boolean;
    codeFontSize: number;
    monoFontFamily: string;
  };
  mode:
    | {
        kind: "working_tree";
        viewMode: "flat" | "tree";
        expandedPaths: string[];
        collapsedFolders: string[];
        reviewActions?: InlineReviewActions;
        onExpandedPathsChange: (paths: string[]) => void;
        onCollapsedFoldersChange: (paths: string[]) => void;
      }
    | {
        kind: "commit";
      };
}

export function SharedDiffView({ files, displayPreferences, mode }: SharedDiffViewProps) {
  const { layout, wrapLines, codeFontSize, monoFontFamily } = displayPreferences;
  const diffBodyLineHeight = Math.round(codeFontSize * 1.5);
  const typographyKey = [monoFontFamily, codeFontSize, diffBodyLineHeight].join(":");
  const textMetricsStyle = useMemo<TextStyle>(() => {
    const trimmedMonoFontFamily = monoFontFamily.trim();
    return {
      fontSize: codeFontSize,
      lineHeight: diffBodyLineHeight,
      ...(trimmedMonoFontFamily ? { fontFamily: trimmedMonoFontFamily } : null),
    };
  }, [codeFontSize, diffBodyLineHeight, monoFontFamily]);
  const viewMode = mode.kind === "working_tree" ? mode.viewMode : "flat";
  const expandedPathsArray = useMemo(
    () => (mode.kind === "working_tree" ? mode.expandedPaths : files.map((file) => file.path)),
    [files, mode],
  );
  const expandedPaths = useMemo(() => new Set(expandedPathsArray), [expandedPathsArray]);
  const collapsedFoldersArray =
    mode.kind === "working_tree" ? mode.collapsedFolders : EMPTY_PATH_LIST;
  const collapsedFolders = useMemo(() => new Set(collapsedFoldersArray), [collapsedFoldersArray]);
  const stickyHeaders = mode.kind === "working_tree";
  const interactive = mode.kind === "working_tree";
  const reviewActions = mode.kind === "working_tree" ? mode.reviewActions : undefined;
  const compressedTree = useMemo(() => compressSingleChildChains(buildDiffTree(files)), [files]);
  const allFolderPaths = useMemo(() => collectDirPaths(compressedTree), [compressedTree]);
  const allFolderPathSet = useMemo(() => new Set(allFolderPaths), [allFolderPaths]);
  const effectiveCollapsedFolders = useMemo(
    () => new Set(Array.from(collapsedFolders).filter((path) => allFolderPathSet.has(path))),
    [allFolderPathSet, collapsedFolders],
  );
  const diffListRef = useRef<FlatList<DiffFlatItem>>(null);
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByKeyRef = useRef<Record<string, number>>({});
  const folderRowHeightRef = useRef<number>(0);
  const defaultHeaderHeightRef = useRef<number>(44);
  const [heightVersion, setHeightVersion] = useState(0);
  const diffBodyChromeHeight = BORDER_WIDTH[1] * 2;
  const statusBodyHeightEstimate = diffBodyChromeHeight + SPACING[4] * 2 + diffBodyLineHeight;

  const { flatItems, stickyHeaderIndices } = useMemo(() => {
    const { items, stickyHeaderIndices: stickyIndices } = buildDiffFlatItems({
      files,
      viewMode,
      tree: compressedTree,
      collapsedFolders: effectiveCollapsedFolders,
      expandedPaths,
    });
    return {
      flatItems: items,
      stickyHeaderIndices: stickyHeaders ? stickyIndices : [],
    };
  }, [compressedTree, effectiveCollapsedFolders, expandedPaths, files, stickyHeaders, viewMode]);

  const getBodyHeightKey = useCallback(
    (file: ParsedDiffFile): string => {
      if (file.status === "too_large" || file.status === "binary") {
        return `${layout}:${wrapLines ? "wrap" : "scroll"}:${typographyKey}:${file.path}:${file.status}`;
      }

      return [
        layout,
        wrapLines ? "wrap" : "scroll",
        typographyKey,
        file.path,
        file.status ?? "ok",
        file.additions,
        file.deletions,
        file.hunks.length,
        getUnifiedDiffLineCount(file),
        getDiffContentLength(file),
      ].join(":");
    },
    [layout, typographyKey, wrapLines],
  );

  const estimateBodyHeight = useCallback(
    (file: ParsedDiffFile): number => {
      if (file.status === "too_large" || file.status === "binary") {
        return statusBodyHeightEstimate;
      }

      const lineCount =
        layout === "split" ? buildSplitDiffRows(file).length : getUnifiedDiffLineCount(file);
      return diffBodyChromeHeight + lineCount * diffBodyLineHeight;
    },
    [diffBodyChromeHeight, diffBodyLineHeight, layout, statusBodyHeightEstimate],
  );

  const getFlatItemHeight = useCallback(
    (item: DiffFlatItem): number => {
      if (item.type === "folder") {
        return folderRowHeightRef.current || defaultHeaderHeightRef.current;
      }
      if (item.type === "header") {
        return headerHeightByPathRef.current[item.file.path] ?? defaultHeaderHeightRef.current;
      }
      const bodyHeightKey = getBodyHeightKey(item.file);
      return bodyHeightByKeyRef.current[bodyHeightKey] ?? estimateBodyHeight(item.file);
    },
    [estimateBodyHeight, getBodyHeightKey],
  );

  const handleFolderRowHeightChange = useCallback((height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previousHeight = folderRowHeightRef.current;
    if (previousHeight > 0 && Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON) {
      return;
    }
    folderRowHeightRef.current = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previousHeight = headerHeightByPathRef.current[path];
    if (
      previousHeight !== undefined &&
      Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
    ) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    defaultHeaderHeightRef.current = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleBodyHeightChange = useCallback(
    (file: ParsedDiffFile, height: number) => {
      if (!Number.isFinite(height) || height < 0) {
        return;
      }
      const heightKey = getBodyHeightKey(file);
      const previousHeight = bodyHeightByKeyRef.current[heightKey];
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
      ) {
        return;
      }
      bodyHeightByKeyRef.current[heightKey] = height;
      setHeightVersion((version) => version + 1);
    },
    [getBodyHeightKey],
  );

  const handleDiffListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    diffListScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const handleDiffListLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    diffListViewportHeightRef.current = height;
  }, []);

  const computeItemOffset = useCallback(
    (predicate: (item: DiffFlatItem) => boolean): number | null => {
      const index = flatItems.findIndex(predicate);
      if (index < 0) {
        return null;
      }
      return sumHeightsBefore(flatItems, index, getFlatItemHeight);
    },
    [flatItems, getFlatItemHeight],
  );

  const computeHeaderOffset = useCallback(
    (path: string): number =>
      computeItemOffset((item) => item.type === "header" && item.file.path === path) ?? 0,
    [computeItemOffset],
  );

  const handleToggleExpanded = useCallback(
    (path: string) => {
      if (mode.kind !== "working_tree") {
        return;
      }
      const isCurrentlyExpanded = expandedPaths.has(path);
      const nextExpanded = !isCurrentlyExpanded;
      const targetOffset = isCurrentlyExpanded ? computeHeaderOffset(path) : null;
      const headerHeight = headerHeightByPathRef.current[path] ?? defaultHeaderHeightRef.current;
      const shouldAnchor =
        isCurrentlyExpanded &&
        targetOffset !== null &&
        shouldAnchorHeaderBeforeCollapse({
          headerOffset: targetOffset,
          headerHeight,
          viewportOffset: diffListScrollOffsetRef.current,
          viewportHeight: diffListViewportHeightRef.current,
        });

      if (shouldAnchor && targetOffset !== null) {
        diffListRef.current?.scrollToOffset({
          offset: targetOffset,
          animated: false,
        });
      }

      mode.onExpandedPathsChange(
        nextExpanded
          ? [...expandedPaths, path]
          : Array.from(expandedPaths).filter((expandedPath) => expandedPath !== path),
      );
    },
    [computeHeaderOffset, expandedPaths, mode],
  );

  const handleToggleFolder = useCallback(
    (dirPath: string) => {
      if (mode.kind !== "working_tree") {
        return;
      }
      const isCurrentlyCollapsed = effectiveCollapsedFolders.has(dirPath);
      if (!isCurrentlyCollapsed) {
        const targetOffset = computeItemOffset(
          (item) => item.type === "folder" && item.dirPath === dirPath,
        );
        const folderHeight = folderRowHeightRef.current || defaultHeaderHeightRef.current;
        if (
          targetOffset !== null &&
          shouldAnchorHeaderBeforeCollapse({
            headerOffset: targetOffset,
            headerHeight: folderHeight,
            viewportOffset: diffListScrollOffsetRef.current,
            viewportHeight: diffListViewportHeightRef.current,
          })
        ) {
          diffListRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
        }
      }

      mode.onCollapsedFoldersChange(
        isCurrentlyCollapsed
          ? Array.from(effectiveCollapsedFolders).filter((path) => path !== dirPath)
          : [...effectiveCollapsedFolders, dirPath],
      );
    },
    [computeItemOffset, effectiveCollapsedFolders, mode],
  );

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffFlatItem }) => {
      if (item.type === "folder") {
        return (
          <DiffFolderRow
            dirPath={item.dirPath}
            displayName={item.displayName}
            depth={item.depth}
            collapsed={item.collapsed}
            additions={item.additions}
            deletions={item.deletions}
            onToggle={handleToggleFolder}
            onHeightChange={handleFolderRowHeightChange}
            testID={`diff-folder-${item.dirPath}`}
          />
        );
      }
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            isExpanded={item.isExpanded}
            depth={item.depth}
            showDir={viewMode === "flat"}
            interactive={interactive}
            onToggle={interactive ? handleToggleExpanded : undefined}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-file-${item.fileIndex}`}
          />
        );
      }
      return (
        <DiffFileBody
          file={item.file}
          layout={layout}
          wrapLines={wrapLines}
          codeFontSize={codeFontSize}
          textMetricsStyle={textMetricsStyle}
          reviewActions={reviewActions}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-file-${item.fileIndex}-body`}
        />
      );
    },
    [
      codeFontSize,
      handleBodyHeightChange,
      handleFolderRowHeightChange,
      handleHeaderHeightChange,
      handleToggleExpanded,
      handleToggleFolder,
      layout,
      reviewActions,
      textMetricsStyle,
      viewMode,
      wrapLines,
      interactive,
    ],
  );

  const flatKeyExtractor = useCallback(
    (item: DiffFlatItem) =>
      item.type === "folder" ? `folder-${item.dirPath}` : `${item.type}-${item.file.path}`,
    [],
  );

  const getFlatItemLayout = useCallback<DiffFlatItemLayoutGetter>(
    (_data, index) => {
      const offset = sumHeightsBefore(flatItems, index, getFlatItemHeight);
      const item = flatItems[index];
      const length = item ? getFlatItemHeight(item) : 0;
      return { length, offset, index };
    },
    [flatItems, getFlatItemHeight],
  );

  const flatExtraData = useMemo(
    () => ({
      expandedPathsArray,
      collapsedFoldersArray,
      layout,
      typographyKey,
      heightVersion,
      viewMode,
      wrapLines,
      reviewActions,
    }),
    [
      expandedPathsArray,
      collapsedFoldersArray,
      heightVersion,
      layout,
      reviewActions,
      typographyKey,
      viewMode,
      wrapLines,
    ],
  );

  return (
    <FlatList
      ref={diffListRef}
      data={flatItems}
      renderItem={renderFlatItem}
      keyExtractor={flatKeyExtractor}
      getItemLayout={getFlatItemLayout}
      stickyHeaderIndices={stickyHeaderIndices}
      extraData={flatExtraData}
      style={styles.scrollView}
      contentContainerStyle={styles.contentContainer}
      testID="git-diff-scroll"
      onLayout={handleDiffListLayout}
      onScroll={handleDiffListScroll}
      onContentSizeChange={onContentSizeChange}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={!showDesktopWebScrollbar}
      // Mixed-height rows (header + potentially very large body) are prone to clipping artifacts.
      // Keep a larger render window and disable clipping to avoid bodies disappearing mid-scroll.
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={10}
    />
  );
}

interface DeriveStatusStateInputs {
  status: ReturnType<typeof useCheckoutStatusQuery>["status"];
  isStatusLoading: boolean;
  isStatusError: boolean;
  statusError: unknown;
}

interface DerivedStatusState {
  gitStatus: NonNullable<ReturnType<typeof useCheckoutStatusQuery>["status"]> | null;
  isGit: boolean;
  notGit: boolean;
  statusErrorMessage: string | null;
  baseRef: string | undefined;
  hasUncommittedChanges: boolean;
  actionsDisabled: boolean;
  currentBranchName: string | null;
}

function computePaneLayoutCaps(
  isMobile: boolean,
  paneWidth: number,
): { showDesktopWebScrollbar: boolean; canUseSplitLayout: boolean } {
  const isDesktopWeb = isWeb && !isMobile;
  return {
    showDesktopWebScrollbar: isDesktopWeb,
    canUseSplitLayout: isDesktopWeb && paneWidth >= SPLIT_MIN_PANE_WIDTH,
  };
}

function buildDiffTextMetricsStyle(
  monoFontFamilySetting: string,
  fontSize: number,
  lineHeight: number,
): TextStyle {
  const monoFontFamily = monoFontFamilySetting.trim();
  return {
    fontSize,
    lineHeight,
    ...(monoFontFamily ? { fontFamily: monoFontFamily } : null),
  };
}

function deriveStatusState({
  status,
  isStatusLoading,
  isStatusError,
  statusError,
}: DeriveStatusStateInputs): DerivedStatusState {
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const actionsDisabled = !isGit || Boolean(status?.error) || isStatusLoading;
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;
  return {
    gitStatus,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    hasUncommittedChanges,
    actionsDisabled,
    currentBranchName,
  };
}

function computeBaseRefLabel(baseRef: string | undefined, fallbackLabel: string): string {
  if (!baseRef) return fallbackLabel;
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

function computeCommittedDiffDescription(
  branchLabel: string,
  baseRefLabel: string,
): string | undefined {
  if (!branchLabel || !baseRefLabel) {
    return undefined;
  }
  return branchLabel === baseRefLabel ? undefined : `${branchLabel} -> ${baseRefLabel}`;
}

function computePrErrorMessage(
  githubFeaturesEnabled: boolean,
  prPayloadError: { message?: string } | null | undefined,
): string | null {
  if (!githubFeaturesEnabled) return null;
  return prPayloadError?.message ?? null;
}

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
type ForgeSetupAction = "install_cli" | "sign_in" | null;

// Drive the onboarding callout from the forge's auth state so the message names
// the exact next step (install the CLI vs sign in) for whichever forge backs the
// workspace — GitHub included. GitLab additionally requires the host to advertise
// GitLab support, matching the rest of the GitLab UI.
function computeForgeSetupAction(input: {
  forge: Forge;
  forgeProvidersSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupAction {
  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return null;
  }
  switch (input.authState) {
    case "cli_missing":
      return "install_cli";
    case "unauthenticated":
      return "sign_in";
    case "authenticated":
    case "no_remote":
    case "error":
      return null;
    default:
      return null;
  }
}

function parseForgeHost(url: string | null | undefined): string | null {
  return url ? (parseGitRemoteLocation(url)?.host ?? null) : null;
}

function buildForgeSetupMessage(input: {
  action: Exclude<ForgeSetupAction, null>;
  forge: Forge;
  host: string | null;
  t: TFunction;
}): string {
  const { brandLabel, signInCli } = getForgePresentation(input.forge);
  // A forge with no known CLI (an unknown/third-party forge rendered neutrally)
  // has no install/sign-in command to interpolate — show neutral guidance
  // rather than the GitLab-specific callout or a null command.
  if (signInCli === null) {
    return input.t("workspace.git.forgeSetup.generic", { brand: brandLabel });
  }
  if (input.action === "install_cli") {
    return input.t("workspace.git.forgeSetup.installCli", { cli: signInCli, brand: brandLabel });
  }
  const command = buildForgeSignInCommand(input.forge, input.host);
  return input.t("workspace.git.forgeSetup.signIn", { command, brand: brandLabel });
}

function buildDiffModeTriggerStyle(): PressableStyleFn {
  return ({ hovered, pressed, open }) => [
    styles.diffModeTrigger,
    (Boolean(hovered) || pressed || Boolean(open)) && styles.diffModeTriggerHovered,
  ];
}

function buildExpandAllButtonStyle(): PressableStyleFn {
  return ({ hovered, pressed }) => [
    styles.expandAllButton,
    (Boolean(hovered) || pressed) && styles.toggleButtonSelected,
  ];
}

function buildToggleButtonStyle(
  selected: boolean,
  baseStyles: StyleProp<ViewStyle> | StyleProp<ViewStyle>[],
): PressableStyleFn {
  return ({ hovered, pressed }) => [
    baseStyles,
    (selected || Boolean(hovered) || pressed) && styles.toggleButtonSelected,
  ];
}

function shouldEnableCheckoutDiff(input: { paneEnabled: boolean; isGit: boolean }): boolean {
  return input.paneEnabled && input.isGit;
}

interface UseDiffPaneCheckoutDiffInput {
  serverId: string;
  cwd: string;
  diffMode: "uncommitted" | "base";
  baseRef: string | undefined;
  hideWhitespace: boolean;
  diffTool: DiffToolId;
  gitAlgorithm: GitDiffAlgorithm | undefined;
  branchCompare: BranchCompareState | null;
  paneEnabled: boolean;
  isGit: boolean;
}

// Wraps useCheckoutDiffQuery so the branch-compare overlay (mode "refs" takes over
// uncommitted/base while a branch compare is active — see useDiffPaneBranchCompare) lives
// outside GitDiffPane's own function scope. gitAlgorithm is passed through as-is: undefined
// (no explicit user pick) omits the field on the wire so the server/git default applies.
function useDiffPaneCheckoutDiff({
  serverId,
  cwd,
  diffMode,
  baseRef,
  hideWhitespace,
  diffTool,
  gitAlgorithm,
  branchCompare,
  paneEnabled,
  isGit,
}: UseDiffPaneCheckoutDiffInput) {
  const effectiveDiffMode: "uncommitted" | "base" | "refs" = branchCompare ? "refs" : diffMode;
  return {
    ...useCheckoutDiffQuery({
      serverId,
      cwd,
      mode: effectiveDiffMode,
      baseRef,
      ignoreWhitespace: hideWhitespace,
      tool: diffTool,
      gitAlgorithm,
      fromRef: branchCompare?.fromRef,
      toRef: branchCompare?.toRef,
      mergeBase: branchCompare?.mergeBase,
      enabled: shouldEnableCheckoutDiff({ paneEnabled, isGit }),
    }),
    effectiveDiffMode,
  };
}

interface UseDiffPaneBranchCompareInput {
  serverId: string;
  cwd: string;
  client: DaemonClient | null;
  isGit: boolean;
  t: TFunction;
}

interface UseDiffPaneBranchCompareResult {
  branchCompare: BranchCompareState | null;
  branchPickerTarget: "from" | "to" | null;
  diffModeAnchorRef: RefObject<View | null>;
  branchCompareOptions: ComboboxOption[];
  // Display labels (refs/heads-stripped) — precomputed here so JSX in GitDiffPane stays a
  // flat lookup instead of another set of ternaries.
  branchCompareFromLabel: string | null;
  branchCompareToLabel: string | null;
  // DropdownMenuItem description prop wants undefined, not null.
  branchCompareDescription: string | undefined;
  // The ref Combobox's controlled value, resolved for whichever side is currently open.
  branchComparePickerValue: string;
  handleOpenBranchCompare: () => void;
  handleOpenBranchCompareToRef: () => void;
  handleBranchComparePickerOpenChange: (open: boolean) => void;
  handleSelectBranchCompareRef: (branchId: string) => void;
  handleToggleBranchCompareMergeBase: () => void;
  handleSwapBranchCompareRefs: () => void;
  clearBranchCompare: () => void;
}

// Split out of GitDiffPane (which was tripping the complexity lint) so the "Compare with
// branch…" picker's state machine lives in its own function scope. See BranchCompareState
// for the not-persisted contract.
function useDiffPaneBranchCompare({
  serverId,
  cwd,
  client,
  isGit,
  t,
}: UseDiffPaneBranchCompareInput): UseDiffPaneBranchCompareResult {
  const [branchCompare, setBranchCompare] = useState<BranchCompareState | null>(null);
  const [branchPickerTarget, setBranchPickerTarget] = useState<"from" | "to" | null>(null);
  const diffModeAnchorRef = useRef<View>(null);

  const branchCompareSuggestionsQuery = useFetchQuery({
    queryKey: ["checkoutDiffBranchCompareSuggestions", serverId, cwd],
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.getBranchSuggestions({ cwd, limit: 200 });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    dataShape: "list",
    enabled: branchPickerTarget !== null && isGit && Boolean(client),
    retry: false,
    staleTimeMs: 15_000,
  });
  const branchCompareOptions = useMemo<ComboboxOption[]>(
    () => (branchCompareSuggestionsQuery.data ?? []).map((name) => ({ id: name, label: name })),
    [branchCompareSuggestionsQuery.data],
  );

  const handleOpenBranchCompare = useCallback(() => {
    setBranchPickerTarget("from");
  }, []);

  const handleOpenBranchCompareToRef = useCallback(() => {
    setBranchPickerTarget("to");
  }, []);

  const handleBranchComparePickerOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setBranchPickerTarget(null);
    }
  }, []);

  const handleSelectBranchCompareRef = useCallback(
    (branchId: string) => {
      setBranchCompare((prev) => {
        if (branchPickerTarget === "to") {
          return prev ? { ...prev, toRef: branchId } : prev;
        }
        return { fromRef: branchId, toRef: prev?.toRef, mergeBase: prev?.mergeBase ?? true };
      });
      setBranchPickerTarget(null);
    },
    [branchPickerTarget],
  );

  const handleToggleBranchCompareMergeBase = useCallback(() => {
    setBranchCompare((prev) => (prev ? { ...prev, mergeBase: !prev.mergeBase } : prev));
  }, []);

  const handleSwapBranchCompareRefs = useCallback(() => {
    setBranchCompare((prev) =>
      prev
        ? { fromRef: prev.toRef ?? "HEAD", toRef: prev.fromRef, mergeBase: prev.mergeBase }
        : prev,
    );
  }, []);

  const clearBranchCompare = useCallback(() => {
    setBranchCompare(null);
  }, []);

  const branchCompareFromLabel = branchCompare
    ? computeBaseRefLabel(branchCompare.fromRef, branchCompare.fromRef)
    : null;
  const branchCompareToLabel = branchCompare
    ? computeBaseRefLabel(branchCompare.toRef, "HEAD")
    : null;
  const branchCompareDescription = branchCompareFromLabel ?? undefined;
  const branchComparePickerValue =
    branchPickerTarget === "to" ? (branchCompare?.toRef ?? "") : (branchCompare?.fromRef ?? "");

  return {
    branchCompare,
    branchPickerTarget,
    diffModeAnchorRef,
    branchCompareOptions,
    branchCompareFromLabel,
    branchCompareToLabel,
    branchCompareDescription,
    branchComparePickerValue,
    handleOpenBranchCompare,
    handleOpenBranchCompareToRef,
    handleBranchComparePickerOpenChange,
    handleSelectBranchCompareRef,
    handleToggleBranchCompareMergeBase,
    handleSwapBranchCompareRefs,
    clearBranchCompare,
  };
}

// Shown inside the diff error card when the stored base ref no longer resolves
// (BASE_REF_NOT_FOUND). Lets the user pick a new base branch, persists it via
// checkout.baseRef.set, and forces a refresh so the diff recomputes.
function BaseRefReselect({
  serverId,
  cwd,
  client,
}: {
  serverId: string;
  cwd: string;
  client: DaemonClient | null;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const runRefresh = useCheckoutGitActionsStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const anchorRef = useRef<View>(null);

  const suggestionsQuery = useFetchQuery({
    queryKey: ["baseRefReselectSuggestions", serverId, cwd],
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.getBranchSuggestions({ cwd, limit: 200 });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    dataShape: "list",
    enabled: open && Boolean(client),
    retry: false,
    staleTimeMs: 15_000,
  });
  const options = useMemo<ComboboxOption[]>(
    () => (suggestionsQuery.data ?? []).map((name) => ({ id: name, label: name })),
    [suggestionsQuery.data],
  );

  const handleOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const handleSelect = useCallback(
    (baseRef: string) => {
      setOpen(false);
      if (!client) {
        return;
      }
      setSaving(true);
      void (async () => {
        try {
          const result = await client.setBaseRef({ cwd, baseRef });
          if (result.error) {
            toast.error(result.error.message);
            return;
          }
          // The daemon reschedules the diff and pushes a workspace update; force
          // a refresh so the new base takes effect without waiting on the watcher.
          await runRefresh({ serverId, cwd });
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : t("workspace.git.diff.baseReselectFailed"),
          );
        } finally {
          setSaving(false);
        }
      })();
    },
    [client, cwd, runRefresh, serverId, t, toast],
  );

  return (
    <View style={styles.baseReselectContainer}>
      <Pressable
        ref={anchorRef}
        onPress={handleOpen}
        disabled={saving}
        accessibilityRole="button"
        style={styles.baseReselectButton}
      >
        <Text style={styles.baseReselectButtonText}>
          {t("workspace.git.diff.baseReselectAction")}
        </Text>
      </Pressable>
      <Combobox
        options={options}
        value=""
        onSelect={handleSelect}
        searchable
        placeholder={t("branchSwitcher.placeholder")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={t("branchSwitcher.empty")}
        title={t("workspace.git.diff.baseReselectTitle")}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
      />
    </View>
  );
}

function computeDiffModeTriggerLabel(input: {
  t: TFunction;
  branchCompare: BranchCompareState | null;
  diffMode: "uncommitted" | "base";
  uncommittedLabel: string;
  committedLabel: string;
}): string {
  if (input.branchCompare) {
    return input.t("workspace.git.diff.comparingWithBranch", {
      branch: computeBaseRefLabel(input.branchCompare.fromRef, input.branchCompare.fromRef),
    });
  }
  return input.diffMode === "uncommitted" ? input.uncommittedLabel : input.committedLabel;
}

// A plain (non-branch-compare) diff-mode item is only "selected" when no branch compare is
// active; extracted so the two DropdownMenuItem `selected` checks are flat lookups.
function isPlainDiffModeSelected(
  target: "uncommitted" | "base",
  branchCompare: BranchCompareState | null,
  diffMode: "uncommitted" | "base",
): boolean {
  return !branchCompare && diffMode === target;
}

// Minimum Changes-pane width (px) at which side-by-side split is usable; below
// it the two columns truncate badly, so we force unified and hide the toggle.
// The pane is resizable (explorer-sidebar drag handle, width persisted), so
// split re-appears once it's dragged past this; the ~400px default falls back.
const SPLIT_MIN_PANE_WIDTH = 720;

export function GitDiffPane({ serverId, workspaceId, cwd, enabled }: GitDiffPaneProps) {
  const { settings: appSettings } = useAppSettings();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  // Side-by-side split needs room for two gutter+code columns; below this the
  // columns squish to unreadable truncation. The Changes pane is a fixed ~400px
  // side panel by default, so split is only offered once it's dragged wide
  // enough — otherwise we fall back to (and hide the toggle for) unified.
  const [paneWidth, setPaneWidth] = useState(0);
  const handlePaneLayout = useCallback((event: LayoutChangeEvent) => {
    setPaneWidth(event.nativeEvent.layout.width);
  }, []);
  const { showDesktopWebScrollbar, canUseSplitLayout } = computePaneLayoutCaps(isMobile, paneWidth);
  const { preferences: changesPreferences, updatePreferences: updateChangesPreferences } =
    useChangesPreferences();
  const wrapLines = changesPreferences.wrapLines;
  const viewMode = changesPreferences.viewMode;
  const effectiveLayout = canUseSplitLayout ? changesPreferences.layout : "unified";

  const handleToggleWrapLines = useCallback(() => {
    void updateChangesPreferences({ wrapLines: !wrapLines });
  }, [updateChangesPreferences, wrapLines]);

  const handleToggleHideWhitespace = useCallback(() => {
    void updateChangesPreferences({ hideWhitespace: !changesPreferences.hideWhitespace });
  }, [changesPreferences.hideWhitespace, updateChangesPreferences]);

  const handleToggleLayout = useCallback(() => {
    void updateChangesPreferences({
      layout: changesPreferences.layout === "unified" ? "split" : "unified",
    });
  }, [changesPreferences.layout, updateChangesPreferences]);

  // Effective diff text size: the settings-level codeFontSize scaled by the pane's
  // size step (md = 1×, i.e. exactly the settings value). Everything downstream —
  // text metrics, gutter width, getItemLayout estimates — derives from this one value.
  const diffFontSizeStep = changesPreferences.diffFontSize;
  const codeFontSize = resolveDiffFontSize(diffFontSizeStep, appSettings.codeFontSize);
  const diffBodyLineHeight = Math.round(codeFontSize * 1.5);
  const diffBodyTypographyKey = [appSettings.monoFontFamily, codeFontSize, diffBodyLineHeight].join(
    ":",
  );
  const diffTextMetricsStyle = useMemo<TextStyle>(
    () => buildDiffTextMetricsStyle(appSettings.monoFontFamily, codeFontSize, diffBodyLineHeight),
    [appSettings.monoFontFamily, codeFontSize, diffBodyLineHeight],
  );
  // Diff-panel chrome text (empty state, loading/error messages) shares the same
  // status container as diff rows once they render, so it scales with the same
  // codeFontSize setting instead of the fixed UI font ramp. Ratios against the
  // authored FONT_SIZE.code preserve today's look at the default codeFontSize.
  const diffFontSizeRatio = codeFontSize / FONT_SIZE.code;
  const diffEmptyTextStyle = useMemo<TextStyle>(
    () => ({ fontSize: Math.round(FONT_SIZE.lg * diffFontSizeRatio) }),
    [diffFontSizeRatio],
  );
  const diffMessageTextStyle = useMemo<TextStyle>(
    () => ({ fontSize: Math.round(FONT_SIZE.base * diffFontSizeRatio) }),
    [diffFontSizeRatio],
  );
  const diffModeTriggerStyle = useMemo(() => buildDiffModeTriggerStyle(), []);
  const diffEngineTriggerStyle = useMemo(() => buildDiffModeTriggerStyle(), []);
  const branchCompareAdvancedToggleStyle = useMemo(() => buildExpandAllButtonStyle(), []);

  const layoutToggleStyle = useMemo(
    () => buildToggleButtonStyle(false, styles.expandAllButton),
    [],
  );

  const viewModeToggleStyle = useMemo(
    () => buildToggleButtonStyle(viewMode === "tree", styles.expandAllButton),
    [viewMode],
  );

  const expandAllToggleStyle = useMemo(() => buildExpandAllButtonStyle(), []);

  const overflowToggleStyle = useMemo(() => buildExpandAllButtonStyle(), []);

  const toast = useToast();
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const commitDiffPersistenceKey = useMemo(
    () => buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? cwd }),
    [cwd, serverId, workspaceId],
  );
  const handleCommitPress = useCallback(
    (sha: string) => {
      if (!commitDiffPersistenceKey) {
        return;
      }
      openWorkspaceTabFocused(commitDiffPersistenceKey, {
        kind: "commit_diff",
        sha,
      });
    },
    [commitDiffPersistenceKey, openWorkspaceTabFocused],
  );
  const refreshSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const runRefresh = useCheckoutGitActionsStore((s) => s.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((s) => s.getStatus({ serverId, cwd, actionId: "refresh" })) ===
    "pending";

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);

  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const statusState = deriveStatusState({ status, isStatusLoading, isStatusError, statusError });
  const { isGit, notGit, statusErrorMessage, baseRef, hasUncommittedChanges, currentBranchName } =
    statusState;

  // Engine selection (see DiffEngineMenu) — capability is null on servers that predate the
  // diffTools broadcast (COMPAT), in which case non-git engines are hidden entirely.
  const client = useHostRuntimeClient(serverId);
  const diffToolsCapability = useDiffToolsCapability(serverId);
  const {
    status: installStatus,
    error: installError,
    install: installDifftastic,
  } = useInstallDifftastic(client);

  const handleSelectDiffTool = useCallback(
    (tool: DiffToolId) => {
      void updateChangesPreferences({ diffTool: tool });
    },
    [updateChangesPreferences],
  );

  const handleSelectGitAlgorithm = useCallback(
    (algorithm: GitDiffAlgorithm) => {
      void updateChangesPreferences({ diffTool: "git", gitAlgorithm: algorithm });
    },
    [updateChangesPreferences],
  );

  const handleSelectDiffFontSize = useCallback(
    (step: DiffFontSizeStep) => {
      void updateChangesPreferences({ diffFontSize: step });
    },
    [updateChangesPreferences],
  );

  // Arbitrary branch/ref compare (see the "Compare with branch…" item below). Deliberately
  // not persisted to changes-preferences: branches can be deleted, so a stale ref would
  // reopen to a broken state — every restart falls back to uncommitted.
  const {
    branchCompare,
    branchPickerTarget,
    diffModeAnchorRef,
    branchCompareOptions,
    branchCompareToLabel,
    branchCompareDescription,
    branchComparePickerValue,
    handleOpenBranchCompare,
    handleOpenBranchCompareToRef,
    handleBranchComparePickerOpenChange,
    handleSelectBranchCompareRef,
    handleToggleBranchCompareMergeBase,
    handleSwapBranchCompareRefs,
    clearBranchCompare,
  } = useDiffPaneBranchCompare({ serverId, cwd, client, isGit, t });

  const reviewDraftScopeKey = useMemo(
    () =>
      buildReviewDraftScopeKey({
        serverId,
        workspaceId,
        cwd,
        baseRef,
        ignoreWhitespace: changesPreferences.hideWhitespace,
      }),
    [baseRef, changesPreferences.hideWhitespace, cwd, serverId, workspaceId],
  );
  const diffMode = useResolvedDiffMode({
    scopeKey: reviewDraftScopeKey,
    hasUncommittedChanges,
  });
  const setDiffModeOverride = useSetDiffModeOverride();

  // Branch compare is an overlay on top of uncommitted/base — it doesn't participate in the
  // review-draft override machinery (no ref persistence, see branchCompare above).
  const {
    files,
    payloadError: diffPayloadError,
    isLoading: isDiffLoading,
  } = useDiffPaneCheckoutDiff({
    serverId,
    cwd,
    diffMode,
    baseRef,
    hideWhitespace: changesPreferences.hideWhitespace,
    diffTool: changesPreferences.diffTool,
    gitAlgorithm: changesPreferences.gitAlgorithm,
    branchCompare,
    paneEnabled: enabled !== false,
    isGit,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef,
        ignoreWhitespace: changesPreferences.hideWhitespace,
      }),
    [baseRef, changesPreferences.hideWhitespace, cwd, diffMode, serverId, workspaceId],
  );

  const handleSelectUncommitted = useCallback(() => {
    clearBranchCompare();
    setDiffModeOverride({
      scopeKey: reviewDraftScopeKey,
      override: { serverId, cwd, mode: "uncommitted", isDirtyAtSelection: hasUncommittedChanges },
    });
  }, [
    clearBranchCompare,
    cwd,
    hasUncommittedChanges,
    reviewDraftScopeKey,
    serverId,
    setDiffModeOverride,
  ]);

  const handleSelectBase = useCallback(() => {
    clearBranchCompare();
    setDiffModeOverride({
      scopeKey: reviewDraftScopeKey,
      override: { serverId, cwd, mode: "base", isDirtyAtSelection: hasUncommittedChanges },
    });
  }, [
    clearBranchCompare,
    cwd,
    hasUncommittedChanges,
    reviewDraftScopeKey,
    serverId,
    setDiffModeOverride,
  ]);

  const reviewActions = useInlineReviewController({
    reviewDraftKey,
  });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef,
  });
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    setWorkspaceAttachments({
      scopeKey: workspaceAttachmentScopeKey,
      attachments: reviewAttachment ? [reviewAttachment] : [],
    });

    return () => {
      clearWorkspaceAttachments({ scopeKey: workspaceAttachmentScopeKey });
    };
  }, [
    clearWorkspaceAttachments,
    reviewAttachment,
    setWorkspaceAttachments,
    workspaceAttachmentScopeKey,
  ]);
  const {
    githubFeaturesEnabled,
    forge,
    authState,
    payloadError: prPayloadError,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  const forgeProvidersSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.forgeProviders === true,
  );
  const forgeSetupAction = computeForgeSetupAction({
    forge,
    forgeProvidersSupported,
    authState,
  });
  const forgeSetupMessage = useMemo(
    () =>
      forgeSetupAction
        ? buildForgeSetupMessage({
            action: forgeSetupAction,
            forge,
            host: parseForgeHost(status?.remoteUrl),
            t,
          })
        : null,
    [forgeSetupAction, forge, status?.remoteUrl, t],
  );
  const normalizedWorkspaceRoot = useMemo(() => cwd.trim(), [cwd]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.diffExpandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setDiffExpandedPathsForWorkspace = usePanelStore(
    (state) => state.setDiffExpandedPathsForWorkspace,
  );
  const expandedPaths = useMemo(() => new Set(expandedPathsArray ?? []), [expandedPathsArray]);
  // The Changes view groups files into a directory tree on every form factor,
  // consistent with the Files explorer (which is also a tree on mobile).
  const collapsedFoldersArray = usePanelStore((state) =>
    workspaceStateKey ? state.diffCollapsedFoldersByWorkspace[workspaceStateKey] : undefined,
  );
  const setDiffCollapsedFoldersForWorkspace = usePanelStore(
    (state) => state.setDiffCollapsedFoldersForWorkspace,
  );
  const stableExpandedPathsArray = expandedPathsArray ?? EMPTY_PATH_LIST;
  const stableCollapsedFoldersArray = collapsedFoldersArray ?? EMPTY_PATH_LIST;
  const sharedDisplayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines,
      codeFontSize,
      monoFontFamily: appSettings.monoFontFamily,
    }),
    [appSettings.monoFontFamily, codeFontSize, effectiveLayout, wrapLines],
  );
  const handleToggleViewMode = useCallback(() => {
    const nextViewMode = viewMode === "flat" ? "tree" : "flat";
    if (nextViewMode === "tree" && workspaceStateKey) {
      setDiffCollapsedFoldersForWorkspace(workspaceStateKey, []);
    }
    void updateChangesPreferences({ viewMode: nextViewMode });
  }, [setDiffCollapsedFoldersForWorkspace, updateChangesPreferences, viewMode, workspaceStateKey]);
  const scrollbar = useWebScrollViewScrollbar(diffListRef, {
    enabled: showDesktopWebScrollbar,
  });
  const diffListScrollOffsetRef = useRef(0);
  const diffListViewportHeightRef = useRef(0);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByKeyRef = useRef<Record<string, number>>({});
  // Folder rows are a distinct kind; keep their height out of headerHeightByPathRef
  // (Codex item 6) so file/folder heights can't collide by path.
  const folderRowHeightRef = useRef<number>(0);
  const defaultHeaderHeightRef = useRef<number>(44);
  const [heightVersion, setHeightVersion] = useState(0);
  const diffBodyChromeHeight = BORDER_WIDTH[1] * 2;
  const statusBodyHeightEstimate = diffBodyChromeHeight + SPACING[4] * 2 + diffBodyLineHeight;
  const { flatItems, stickyHeaderIndices } = useMemo(() => {
    const { items, stickyHeaderIndices: stickyIndices } = buildDiffFlatItems({
      files,
      viewMode,
      tree: compressedTree,
      collapsedFolders,
      expandedPaths,
    });
    return { flatItems: items, stickyHeaderIndices: stickyIndices };
  }, [compressedTree, collapsedFolders, expandedPaths, files, viewMode]);

  const getBodyHeightKey = useCallback(
    (file: ParsedDiffFile): string => {
      if (file.status === "too_large" || file.status === "binary") {
        return `${effectiveLayout}:${wrapLines ? "wrap" : "scroll"}:${diffBodyTypographyKey}:${file.path}:${file.status}`;
      }

      return [
        effectiveLayout,
        wrapLines ? "wrap" : "scroll",
        diffBodyTypographyKey,
        file.path,
        file.status ?? "ok",
        file.additions,
        file.deletions,
        file.hunks.length,
        getUnifiedDiffLineCount(file),
        getDiffContentLength(file),
      ].join(":");
    },
    [diffBodyTypographyKey, effectiveLayout, wrapLines],
  );

  const estimateBodyHeight = useCallback(
    (file: ParsedDiffFile): number => {
      if (file.status === "too_large" || file.status === "binary") {
        return statusBodyHeightEstimate;
      }

      const lineCount =
        effectiveLayout === "split"
          ? buildSplitDiffRows(file).length
          : getUnifiedDiffLineCount(file);
      return diffBodyChromeHeight + lineCount * diffBodyLineHeight;
    },
    [diffBodyChromeHeight, diffBodyLineHeight, effectiveLayout, statusBodyHeightEstimate],
  );

  // Single height source of truth for both getItemLayout and the collapse
  // scroll-anchor math. Folder rows use their own measured height (Codex item 6),
  // falling back to the default header height before first measurement.
  const getFlatItemHeight = useCallback(
    (item: DiffFlatItem): number => {
      if (item.type === "folder") {
        return folderRowHeightRef.current || defaultHeaderHeightRef.current;
      }
      if (item.type === "header") {
        return headerHeightByPathRef.current[item.file.path] ?? defaultHeaderHeightRef.current;
      }
      const bodyHeightKey = getBodyHeightKey(item.file);
      return bodyHeightByKeyRef.current[bodyHeightKey] ?? estimateBodyHeight(item.file);
    },
    [estimateBodyHeight, getBodyHeightKey],
  );

  const handleFolderRowHeightChange = useCallback((height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previousHeight = folderRowHeightRef.current;
    if (previousHeight > 0 && Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON) {
      return;
    }
    folderRowHeightRef.current = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previousHeight = headerHeightByPathRef.current[path];
    if (
      previousHeight !== undefined &&
      Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
    ) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    defaultHeaderHeightRef.current = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleBodyHeightChange = useCallback(
    (file: ParsedDiffFile, height: number) => {
      if (!Number.isFinite(height) || height < 0) {
        return;
      }
      const heightKey = getBodyHeightKey(file);
      const previousHeight = bodyHeightByKeyRef.current[heightKey];
      if (
        previousHeight !== undefined &&
        Math.abs(previousHeight - height) <= DIFF_HEIGHT_CHANGE_EPSILON
      ) {
        return;
      }
      bodyHeightByKeyRef.current[heightKey] = height;
      setHeightVersion((version) => version + 1);
    },
    [getBodyHeightKey],
  );

  const handleDiffListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      diffListScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
      scrollbar.onScroll(event);
    },
    [scrollbar],
  );

  const handleDiffListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      diffListViewportHeightRef.current = height;
      scrollbar.onLayout(event);
    },
    [scrollbar],
  );

  // Offset of the first item matching `predicate`, walking the SAME flatItems
  // list getFlatItemLayout uses so folder rows are counted (single source of
  // truth — Codex item 5 / finding 2).
  const computeItemOffset = useCallback(
    (predicate: (item: DiffFlatItem) => boolean): number | null => {
      const index = flatItems.findIndex(predicate);
      if (index < 0) {
        return null;
      }
      return sumHeightsBefore(flatItems, index, getFlatItemHeight);
    },
    [flatItems, getFlatItemHeight],
  );

  const computeHeaderOffset = useCallback(
    (path: string): number =>
      computeItemOffset((item) => item.type === "header" && item.file.path === path) ?? 0,
    [computeItemOffset],
  );

  const handleToggleExpanded = useCallback(
    (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const isCurrentlyExpanded = expandedPaths.has(path);
      const nextExpanded = !isCurrentlyExpanded;
      const targetOffset = isCurrentlyExpanded ? computeHeaderOffset(path) : null;
      const headerHeight = headerHeightByPathRef.current[path] ?? defaultHeaderHeightRef.current;
      const shouldAnchor =
        isCurrentlyExpanded &&
        targetOffset !== null &&
        shouldAnchorHeaderBeforeCollapse({
          headerOffset: targetOffset,
          headerHeight,
          viewportOffset: diffListScrollOffsetRef.current,
          viewportHeight: diffListViewportHeightRef.current,
        });

      // Anchor to the clicked header before collapsing so visual context is preserved.
      if (shouldAnchor && targetOffset !== null) {
        diffListRef.current?.scrollToOffset({
          offset: targetOffset,
          animated: false,
        });
      }

      const nextPaths = nextExpanded
        ? [...expandedPaths, path]
        : Array.from(expandedPaths).filter((expandedPath) => expandedPath !== path);
      setDiffExpandedPathsForWorkspace(workspaceStateKey, nextPaths);
    },
    [computeHeaderOffset, expandedPaths, setDiffExpandedPathsForWorkspace, workspaceStateKey],
  );

  const handleToggleFolder = useCallback(
    (dirPath: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const isCurrentlyCollapsed = collapsedFolders.has(dirPath);
      // Collapsing hides the subtree below this row; anchor to the folder row
      // first so the viewport doesn't jump to a dead offset (Codex item 5).
      if (!isCurrentlyCollapsed) {
        const targetOffset = computeItemOffset(
          (item) => item.type === "folder" && item.dirPath === dirPath,
        );
        const folderHeight = folderRowHeightRef.current || defaultHeaderHeightRef.current;
        if (
          targetOffset !== null &&
          shouldAnchorHeaderBeforeCollapse({
            headerOffset: targetOffset,
            headerHeight: folderHeight,
            viewportOffset: diffListScrollOffsetRef.current,
            viewportHeight: diffListViewportHeightRef.current,
          })
        ) {
          diffListRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
        }
      }

      const nextCollapsed = isCurrentlyCollapsed
        ? Array.from(collapsedFolders).filter((path) => path !== dirPath)
        : [...collapsedFolders, dirPath];
      setDiffCollapsedFoldersForWorkspace(workspaceStateKey, nextCollapsed);
    },
    [collapsedFolders, computeItemOffset, setDiffCollapsedFoldersForWorkspace, workspaceStateKey],
  );

  const allFileDiffsExpanded = useMemo(() => {
    if (files.length === 0) return false;
    return files.every((file) => expandedPaths.has(file.path));
  }, [expandedPaths, files]);

  const handleToggleExpandAll = useCallback(() => {
    if (!workspaceStateKey) {
      return;
    }
    if (allFileDiffsExpanded) {
      setDiffExpandedPathsForWorkspace(workspaceStateKey, []);
    } else {
      setDiffExpandedPathsForWorkspace(
        workspaceStateKey,
        files.map((file) => file.path),
      );
    }
  }, [allFileDiffsExpanded, files, setDiffExpandedPathsForWorkspace, workspaceStateKey]);

  const renderFlatItem = useCallback(
    ({ item }: { item: DiffFlatItem }) => {
      if (item.type === "folder") {
        return (
          <DiffFolderRow
            dirPath={item.dirPath}
            displayName={item.displayName}
            depth={item.depth}
            collapsed={item.collapsed}
            additions={item.additions}
            deletions={item.deletions}
            onToggle={handleToggleFolder}
            onHeightChange={handleFolderRowHeightChange}
            testID={`diff-folder-${item.dirPath}`}
          />
        );
      }
      if (item.type === "header") {
        return (
          <DiffFileHeader
            file={item.file}
            isExpanded={item.isExpanded}
            depth={item.depth}
            showDir={viewMode === "flat"}
            onToggle={handleToggleExpanded}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-file-${item.fileIndex}`}
            activeDiffTool={changesPreferences.diffTool}
          />
        );
      }
      return (
        <DiffFileBody
          file={item.file}
          layout={effectiveLayout}
          wrapLines={wrapLines}
          codeFontSize={codeFontSize}
          textMetricsStyle={diffTextMetricsStyle}
          reviewActions={reviewActions}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-file-${item.fileIndex}-body`}
        />
      );
    },
    [
      changesPreferences.diffTool,
      codeFontSize,
      diffTextMetricsStyle,
      effectiveLayout,
      handleBodyHeightChange,
      handleFolderRowHeightChange,
      handleHeaderHeightChange,
      handleToggleExpanded,
      handleToggleFolder,
      reviewActions,
      viewMode,
      wrapLines,
    ],
  );

  const flatKeyExtractor = useCallback(
    (item: DiffFlatItem) =>
      item.type === "folder" ? `folder-${item.dirPath}` : `${item.type}-${item.file.path}`,
    [],
  );

  const getFlatItemLayout = useCallback<DiffFlatItemLayoutGetter>(
    (_data, index) => {
      const offset = sumHeightsBefore(flatItems, index, getFlatItemHeight);
      const item = flatItems[index];
      const length = item ? getFlatItemHeight(item) : 0;
      return { length, offset, index };
    },
    [flatItems, getFlatItemHeight],
  );

  const flatExtraData = useMemo(
    () => ({
      expandedPathsArray,
      collapsedFoldersArray,
      effectiveLayout,
      diffBodyTypographyKey,
      heightVersion,
      viewMode,
      wrapLines,
      reviewActions,
      diffTool: changesPreferences.diffTool,
    }),
    [
      changesPreferences.diffTool,
      expandedPathsArray,
      collapsedFoldersArray,
      effectiveLayout,
      diffBodyTypographyKey,
      heightVersion,
      viewMode,
      wrapLines,
      reviewActions,
    ],
  );

  const hasChanges = files.length > 0;
  const diffErrorMessage = diffPayloadError?.message ?? null;
  const baseReselectSlot = useMemo(
    () => (client ? <BaseRefReselect serverId={serverId} cwd={cwd} client={client} /> : null),
    [client, cwd, serverId],
  );
  const prErrorMessage = computePrErrorMessage(githubFeaturesEnabled, prPayloadError);
  const baseRefLabel = useMemo(
    () => computeBaseRefLabel(baseRef, t("workspace.git.diff.base")),
    [baseRef, t],
  );
  const gitActionsIcons = useMemo(
    () => ({
      commit: <ThemedGitCommitHorizontal size={16} uniProps={foregroundMutedIconColorMapping} />,
      pull: <ThemedDownload size={16} uniProps={foregroundMutedIconColorMapping} />,
      push: <ThemedUpload size={16} uniProps={foregroundMutedIconColorMapping} />,
      pullAndPush: <ThemedArrowDownUp size={16} uniProps={foregroundMutedIconColorMapping} />,
      merge: <ThemedGitMerge size={16} uniProps={foregroundMutedIconColorMapping} />,
      mergeFromBase: <ThemedRefreshCcw size={16} uniProps={foregroundMutedIconColorMapping} />,
      archive: <ThemedArchive size={16} uniProps={foregroundMutedIconColorMapping} />,
    }),
    [],
  );
  const { gitActions, branchLabel } = useGitActions({
    serverId,
    cwd,
    icons: gitActionsIcons,
  });
  const committedDiffDescription = useMemo(
    () => computeCommittedDiffDescription(branchLabel, baseRefLabel),
    [baseRefLabel, branchLabel],
  );
  const uncommittedLabel = t("workspace.git.diff.uncommitted");
  const committedLabel = t("workspace.git.diff.committed");
  const diffModeTriggerLabel = computeDiffModeTriggerLabel({
    t,
    branchCompare,
    diffMode,
    uncommittedLabel,
    committedLabel,
  });

  const emptyMessage = computeEmptyMessage(
    changesPreferences.hideWhitespace,
    diffMode,
    baseRefLabel,
    {
      hiddenWhitespace: t("workspace.git.diff.emptyHiddenWhitespace"),
      uncommitted: t("workspace.git.diff.emptyUncommitted"),
      againstBase: (label) => t("workspace.git.diff.emptyAgainstBase", { baseRef: label }),
    },
  );

  const bodyContent: ReactElement = (
    <DiffBodyContent
      isStatusLoading={isStatusLoading}
      statusErrorMessage={statusErrorMessage}
      notGit={notGit}
      isDiffLoading={isDiffLoading}
      diffErrorMessage={diffErrorMessage}
      diffErrorCode={diffPayloadError?.code ?? null}
      baseReselectSlot={baseReselectSlot}
      hasChanges={hasChanges}
      emptyMessage={emptyMessage}
      flatItems={flatItems}
      stickyHeaderIndices={stickyHeaderIndices}
      renderFlatItem={renderFlatItem}
      flatKeyExtractor={flatKeyExtractor}
      getFlatItemLayout={getFlatItemLayout}
      flatExtraData={flatExtraData}
      diffListRef={diffListRef}
      handleDiffListLayout={handleDiffListLayout}
      handleDiffListScroll={handleDiffListScroll}
      onContentSizeChange={scrollbar.onContentSizeChange}
      showDesktopWebScrollbar={showDesktopWebScrollbar}
      checkingRepositoryLabel={t("workspace.git.diff.checkingRepository")}
      notRepositoryLabel={t("workspace.git.diff.notRepository")}
      diffEmptyTextStyle={diffEmptyTextStyle}
      diffMessageTextStyle={diffMessageTextStyle}
    />
  );

  return (
    <View style={styles.container} onLayout={handlePaneLayout}>
      {isGit && (currentBranchName || isMobile) ? (
        <View style={styles.header} testID="changes-header">
          <BranchSwitcher
            currentBranchName={currentBranchName}
            serverId={serverId}
            workspaceId={workspaceId ?? cwd}
            workspaceDirectory={cwd}
            isGitCheckout={isGit}
            testID="changes-branch-switcher"
          />
          {isMobile ? <GitActionsSplitButton gitActions={gitActions} /> : null}
        </View>
      ) : null}

      {isGit ? (
        <View style={styles.diffStatusContainer}>
          <View style={styles.diffStatusInner}>
            <View ref={diffModeAnchorRef} collapsable={false}>
              <DropdownMenu>
                <DropdownMenuTrigger
                  style={diffModeTriggerStyle}
                  testID="changes-diff-status"
                  accessibilityRole="button"
                  accessibilityLabel={t("workspace.git.diff.diffMode")}
                >
                  <Text style={styles.diffStatusText} numberOfLines={1}>
                    {diffModeTriggerLabel}
                  </Text>
                  <ThemedChevronDown size={12} uniProps={foregroundMutedIconColorMapping} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" width={260} testID="changes-diff-status-menu">
                  <DropdownMenuItem
                    testID="changes-diff-mode-uncommitted"
                    selected={isPlainDiffModeSelected("uncommitted", branchCompare, diffMode)}
                    onSelect={handleSelectUncommitted}
                  >
                    {uncommittedLabel}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    testID="changes-diff-mode-committed"
                    selected={isPlainDiffModeSelected("base", branchCompare, diffMode)}
                    description={committedDiffDescription}
                    onSelect={handleSelectBase}
                  >
                    {committedLabel}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    testID="changes-diff-mode-branch"
                    selected={branchCompare !== null}
                    description={branchCompareDescription}
                    onSelect={handleOpenBranchCompare}
                  >
                    {t("workspace.git.diff.compareWithBranch")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Combobox
                options={branchCompareOptions}
                value={branchComparePickerValue}
                onSelect={handleSelectBranchCompareRef}
                searchable
                placeholder={t("branchSwitcher.placeholder")}
                searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
                emptyText={t("branchSwitcher.empty")}
                title={t("workspace.git.diff.branchCompareTitle")}
                open={branchPickerTarget !== null}
                onOpenChange={handleBranchComparePickerOpenChange}
                anchorRef={diffModeAnchorRef}
                desktopPlacement="bottom-start"
                desktopPreventInitialFlash
                desktopMinWidth={280}
              />
            </View>
            <BranchCompareAdvancedControls
              branchCompare={branchCompare}
              branchCompareToLabel={branchCompareToLabel}
              toggleStyle={branchCompareAdvancedToggleStyle}
              onOpenToRef={handleOpenBranchCompareToRef}
              onSwap={handleSwapBranchCompareRefs}
              onToggleMergeBase={handleToggleBranchCompareMergeBase}
            />
            <View style={styles.diffStatusButtons}>
              <DiffEngineMenu
                diffTool={changesPreferences.diffTool}
                gitAlgorithm={changesPreferences.gitAlgorithm}
                triggerStyle={diffEngineTriggerStyle}
                diffToolsCapability={diffToolsCapability}
                installStatus={installStatus}
                installError={installError}
                onSelectTool={handleSelectDiffTool}
                onSelectGitAlgorithm={handleSelectGitAlgorithm}
                onInstallDifftastic={installDifftastic}
              />
              {canUseSplitLayout ? (
                <DiffLayoutToggle
                  layout={changesPreferences.layout}
                  isMobile={isMobile}
                  toggleStyle={layoutToggleStyle}
                  onToggle={handleToggleLayout}
                />
              ) : null}
              {files.length > 0 ? (
                <DiffViewModeToggle
                  viewMode={viewMode}
                  isMobile={isMobile}
                  toggleStyle={viewModeToggleStyle}
                  onToggle={handleToggleViewMode}
                />
              ) : null}
              {files.length > 0 ? (
                <DiffFilesToolbar
                  allFileDiffsExpanded={allFileDiffsExpanded}
                  isMobile={isMobile}
                  expandAllToggleStyle={expandAllToggleStyle}
                  onToggleExpandAll={handleToggleExpandAll}
                />
              ) : null}
              <DiffOptionsMenu
                brand={getForgePresentation(forge).brandLabel}
                diffFontSize={diffFontSizeStep}
                hideWhitespace={changesPreferences.hideWhitespace}
                isMobile={isMobile}
                isRefreshing={isRefreshing}
                overflowToggleStyle={overflowToggleStyle}
                refreshSupported={refreshSupported}
                wrapLines={wrapLines}
                onRefresh={handleRefresh}
                onSelectDiffFontSize={handleSelectDiffFontSize}
                onToggleHideWhitespace={handleToggleHideWhitespace}
                onToggleWrapLines={handleToggleWrapLines}
              />
            </View>
          </View>
        </View>
      ) : null}

      {forgeSetupMessage ? (
        <View style={styles.forgeSetupCallout} testID="forge-setup-callout">
          <Text style={styles.forgeSetupCalloutText}>{forgeSetupMessage}</Text>
        </View>
      ) : null}

      {prErrorMessage ? <Text style={styles.actionErrorText}>{prErrorMessage}</Text> : null}

      <View style={styles.diffContainer}>
        {bodyContent}
        {hasChanges ? scrollbar.overlay : null}
      </View>

      <CommitsSection serverId={serverId} cwd={cwd} onCommitPress={handleCommitPress} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffStatusContainer: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  diffStatusInner: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
  },
  diffModeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    // Align text with header branch icon (at spacing[3] from edge, minus our horizontal padding)
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: {
      xs: 28,
      sm: 28,
      md: 24,
    },
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  diffModeTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffModeTriggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatusText: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.25,
    color: theme.colors.foregroundMuted,
  },
  diffStatusIconHidden: {
    opacity: 0,
  },
  diffStatusButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  toggleButtonSelected: {
    backgroundColor: theme.colors.surface2,
  },
  expandAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    minWidth: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    height: {
      xs: 32,
      sm: 32,
      md: 24,
    },
    paddingHorizontal: {
      xs: theme.spacing[2],
      sm: theme.spacing[2],
      md: theme.spacing[1],
    },
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  actionErrorText: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  forgeSetupCallout: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  forgeSetupCalloutText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: theme.spacing[8],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  baseReselectContainer: {
    marginTop: theme.spacing[4],
    alignItems: "center",
  },
  baseReselectButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  baseReselectButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  fileSection: {
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileSectionHeaderContainer: {
    overflow: "hidden",
  },
  fileSectionHeaderExpanded: {
    backgroundColor: theme.colors.surface1,
  },
  fileSectionBodyContainer: {
    // visible (not hidden): the gutter's add-comment button is intentionally taller
    // than the diff line (22px vs the 18px line height) and sits at right:-10, so the
    // first/last row's button pokes past this container's top/bottom edge. The
    // horizontal scroll clipping of code content is handled independently by
    // DiffScroll's own ScrollView, so this doesn't unclip that.
    overflow: "visible",
    backgroundColor: theme.colors.surface2,
  },
  fileSectionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    minWidth: 0,
    zIndex: 2,
    elevation: 2,
  },
  fileHeaderPressed: {
    opacity: 0.7,
  },
  fileHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  fileHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  fileIcon: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  fileDirSpacer: {
    flex: 1,
    minWidth: 0,
  },
  newBadge: {
    backgroundColor: theme.colors.diffAddedBadgeBg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  newBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  deletedBadge: {
    backgroundColor: theme.colors.diffRemovedBadgeBg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  deletedBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
  },
  // Shown on a file that fell back to the git engine while the pane's selected engine is
  // vscode/difftastic (per-file mapper failure, binary content, etc.).
  lineDiffBadge: {
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  lineDiffBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  additions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
  },
  diffContent: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  diffContentRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  diffContentInner: {
    flexDirection: "column",
  },
  linesContainer: {
    backgroundColor: theme.colors.surface1,
  },
  gutterColumn: {
    backgroundColor: theme.colors.surface1,
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  gutterCell: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    justifyContent: "flex-start",
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  inlineReviewRow: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: theme.colors.surface1,
  },
  inlineReviewGutterSpacer: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexShrink: 0,
  },
  textLineContainer: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingLeft: theme.spacing[2],
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  splitColumnScroll: {
    flex: 1,
  },
  splitHeaderRow: {
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
  },
  splitCell: {
    flex: 1,
    flexBasis: 0,
    backgroundColor: theme.colors.surface2,
  },
  splitCellRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  emptySplitCell: {
    backgroundColor: theme.colors.surfaceDiffEmpty,
  },
  splitCellWithDivider: {
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  diffLineContainer: {
    flexDirection: "row",
    alignItems: "stretch",
    overflow: "visible",
  },
  lineNumberGutter: {
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    marginRight: theme.spacing[2],
    alignSelf: "stretch",
    justifyContent: "flex-start",
    zIndex: 4,
    elevation: 4,
    overflow: "visible",
  },
  diffTextMetrics: {
    fontSize: theme.fontSize.code,
    lineHeight: theme.lineHeight.diff,
    fontFamily: theme.fontFamily.mono,
  },
  lineNumberText: {
    width: "100%",
    textAlign: "right",
    paddingRight: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    userSelect: "none",
  },
  addLineNumberText: {
    color: theme.colors.diffAddition,
  },
  removeLineNumberText: {
    color: theme.colors.diffDeletion,
  },
  diffLineText: {
    flex: 1,
    paddingRight: theme.spacing[3],
    color: theme.colors.foreground,
    userSelect: "text",
  },
  addLineContainer: {
    backgroundColor: theme.colors.diffAddedLineBg,
  },
  addLineText: {
    color: theme.colors.foreground,
  },
  addWordHighlight: {
    backgroundColor: theme.colors.diffAddedWordBg,
  },
  removeLineContainer: {
    backgroundColor: theme.colors.diffRemovedLineBg,
  },
  removeLineText: {
    color: theme.colors.foreground,
  },
  removeWordHighlight: {
    backgroundColor: theme.colors.diffRemovedWordBg,
  },
  headerLineContainer: {
    backgroundColor: theme.colors.surface2,
  },
  headerLineText: {
    color: theme.colors.foregroundMuted,
  },
  contextLineContainer: {
    backgroundColor: theme.colors.surface1,
  },
  contextLineText: {
    color: theme.colors.foregroundMuted,
  },
  emptySplitCellText: {
    color: "transparent",
  },
  statusMessageContainer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[4],
  },
  statusMessageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));

const DIFF_HEIGHT_CHANGE_EPSILON = 0.5;
