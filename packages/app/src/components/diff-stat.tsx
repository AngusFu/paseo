import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface DiffStatProps {
  additions: number;
  deletions: number;
  testID?: string;
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Match the 16px header/source-control glyphs so stats sit on the same vertical center.
const COMPACT_STAT_LINE_HEIGHT = 16;

export function formatDiffCount(value: number): string {
  return compactFormatter.format(value).toLowerCase();
}

export function DiffStat({ additions, deletions, testID }: DiffStatProps) {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.additions}>+{formatDiffCount(additions)}</Text>
      <Text style={styles.deletions}>-{formatDiffCount(deletions)}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: COMPACT_STAT_LINE_HEIGHT,
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  additions: {
    fontSize: theme.fontSize.xs,
    lineHeight: COMPACT_STAT_LINE_HEIGHT,
    fontWeight: theme.fontWeight.normal,
    fontVariant: ["tabular-nums"],
    color: theme.colors.diffAddition,
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    lineHeight: COMPACT_STAT_LINE_HEIGHT,
    fontWeight: theme.fontWeight.normal,
    fontVariant: ["tabular-nums"],
    color: theme.colors.diffDeletion,
  },
}));
