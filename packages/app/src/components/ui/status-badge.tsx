import { useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

type StatusBadgeVariant = "success" | "error" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
}

// A neutral chip carrying a single status-colored dot. The dot does the work of
// signalling state; the surface stays quiet so a page of badges never turns into
// a wall of saturated pills.
export function StatusBadge({ label, variant = "muted" }: StatusBadgeProps) {
  const dotStyle = useMemo(
    () => [
      styles.dot,
      variant === "success" && styles.dotSuccess,
      variant === "error" && styles.dotError,
    ],
    [variant],
  );

  return (
    <View style={styles.pill}>
      <View style={dotStyle} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  dotSuccess: {
    backgroundColor: theme.colors.palette.green[500],
  },
  dotError: {
    backgroundColor: theme.colors.palette.red[500],
  },
  pillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
