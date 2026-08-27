import { useCallback } from "react";
import { Image, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { hasCodeServerBridge, useCodeServer } from "@/workspace/code-server";

const VSCODE_WEB_ICON = require("../../../assets/images/editor-apps/vscode.png");

interface WorkspaceCodeServerButtonProps {
  cwd: string;
}

export function WorkspaceCodeServerButton({ cwd }: WorkspaceCodeServerButtonProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { isAvailable, isRunning, openWorkspace } = useCodeServer({
    isLocalExecution: hasCodeServerBridge(),
  });

  const openMutation = useMutation({
    mutationFn: () => openWorkspace(cwd),
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

  const label = t("workspace.git.openInEditor.vscodeWeb");

  return (
    <HeaderToggleButton
      testID="workspace-code-server-open"
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
          <Image source={VSCODE_WEB_ICON} style={styles.icon} resizeMode="contain" />
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
  icon: {
    width: 16,
    height: 16,
  },
  inactive: isWeb
    ? {
        filter: "grayscale(1)",
        opacity: 0.55,
      }
    : { opacity: 0.55 },
}));
