import { useCallback } from "react";
import { View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useDeepseekHarness } from "@/desktop/deepseek-harness";
import type { Theme } from "@/styles/theme";

const ThemedSparkles = withUnistyles(Sparkles);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface WorkspaceDeepseekHarnessButtonProps {
  cwd: string;
}

export function WorkspaceDeepseekHarnessButton({ cwd }: WorkspaceDeepseekHarnessButtonProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { isAvailable, status, openWorkspace } = useDeepseekHarness();
  const isRunning = status?.running === true;

  const openMutation = useMutation({
    mutationFn: () => openWorkspace({ cwd }),
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : t("workspace.git.openInEditor.failedOpen"),
      );
    },
  });

  const handlePress = useCallback(() => {
    openMutation.mutate();
  }, [openMutation]);

  if (!isAvailable || cwd.trim().length === 0) {
    return null;
  }

  const label = t("workspace.git.openInEditor.deepseekHarness");

  return (
    <HeaderToggleButton
      testID="workspace-deepseek-harness-open"
      onPress={handlePress}
      tooltipLabel={label}
      tooltipKeys={[]}
      tooltipSide="bottom"
      tooltipDelayDuration={300}
      style={styles.compactHeaderActionButton}
      disabled={openMutation.isPending}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {() => (
        <View style={!isRunning && !openMutation.isPending ? styles.inactive : undefined}>
          <ThemedSparkles size={16} uniProps={mutedColorMapping} />
        </View>
      )}
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactHeaderActionButton: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    padding: 0,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  inactive: isWeb
    ? {
        filter: "grayscale(1)",
        opacity: 0.55,
      }
    : { opacity: 0.55 },
}));
