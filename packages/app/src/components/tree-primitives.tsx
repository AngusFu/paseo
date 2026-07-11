import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, Folder, FolderOpen } from "lucide-react-native";
import { SPACING, type Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

// Shared presentation primitives for the app's directory trees. Both the Files
// explorer (server-loaded listings) and the Changes view (client-built from diff
// paths) render different data, but their ROWS should look identical — same
// indentation, guide lines, and chevron. Keep those here so the two trees can't
// drift apart.
export const TREE_INDENT_PER_LEVEL = 16;

/** Left padding for a tree row at `depth`. Shared by folder rows and file headers
 * in the Changes tree so their indentation can't drift apart. */
export function treeRowPaddingLeft(depth: number): number {
  return SPACING[3] + depth * TREE_INDENT_PER_LEVEL;
}

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderOpen = withUnistyles(FolderOpen);

/**
 * Directory folder glyph shown after the disclosure chevron, matching VS Code /
 * GitHub tree rows. Open when expanded, closed when collapsed. Muted so the file
 * type icons (which are colored) stay the visual anchor. Rendered inside
 * `TreeChevron` so every folder row across the app (Changes tree, Files
 * explorer) gets it from the one shared primitive.
 */
function FolderGlyph({ expanded }: { expanded: boolean }) {
  return (
    <View style={styles.folderIcon}>
      {expanded ? (
        <ThemedFolderOpen size={16} uniProps={foregroundMutedIconColorMapping} />
      ) : (
        <ThemedFolder size={16} uniProps={foregroundMutedIconColorMapping} />
      )}
    </View>
  );
}

/**
 * Vertical guide lines connecting nested rows to their ancestors — one line per
 * ancestor depth level, positioned absolutely within the (relative) row. Renders
 * nothing at depth 0.
 */
export function TreeIndentGuides({ depth }: { depth: number }) {
  const guides = useMemo(
    () =>
      Array.from({ length: depth }, (_, index) => ({
        key: index,
        style: [
          styles.indentGuide,
          inlineUnistylesStyle({ left: SPACING[3] + index * TREE_INDENT_PER_LEVEL + 4 }),
        ],
      })),
    [depth],
  );
  return (
    <>
      {guides.map((guide) => (
        <View key={guide.key} style={guide.style} pointerEvents="none" />
      ))}
    </>
  );
}

/**
 * Directory-row disclosure: a rotating chevron (points right, rotates down when
 * expanded) followed by the folder glyph. Used by every folder row in the app
 * (Changes tree and Files explorer) so the two stay identical.
 */
export function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <View style={styles.disclosure}>
      <View style={expanded ? CHEVRON_EXPANDED_STYLE : styles.chevron}>
        <ThemedChevronRight size={16} uniProps={foregroundMutedIconColorMapping} />
      </View>
      <FolderGlyph expanded={expanded} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  indentGuide: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    // surface3 (one step up from the near-invisible surface2) so the guides read
    // against the row background in both light and dark, matching VS Code's
    // low-but-present indent-guide contrast.
    backgroundColor: theme.colors.surface3,
  },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  folderIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
}));

// Stable module-level style ref so TreeChevron passes a constant array, not one created
// per render — satisfies react-perf (no inline-array prop) without a per-render useMemo.
const CHEVRON_EXPANDED_STYLE = [styles.chevron, styles.chevronExpanded];
