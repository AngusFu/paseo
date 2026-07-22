import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { Sparkles, Undo2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { usePromptOptimize } from "@/hooks/use-prompt-optimize";

interface PromptOptimizeButtonProps {
  serverId: string | null | undefined;
  draft: string;
  onReplace: (text: string) => void;
  disabled?: boolean;
}

// One-tap prompt rewrite via the daemon's local model. Replaces the draft in
// place and offers a single-step undo until the user edits the result.
export function PromptOptimizeButton({
  serverId,
  draft,
  onReplace,
  disabled,
}: PromptOptimizeButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const { supported, optimize, isOptimizing } = usePromptOptimize(serverId);
  const previousDraftRef = useRef<string | null>(null);
  const [optimizedText, setOptimizedText] = useState<string | null>(null);

  // The undo affordance only lives while the field still holds the exact
  // optimized text; any user edit dismisses it.
  useEffect(() => {
    if (optimizedText !== null && draft !== optimizedText) {
      setOptimizedText(null);
      previousDraftRef.current = null;
    }
  }, [draft, optimizedText]);

  const handleOptimize = useCallback(() => {
    if (isOptimizing) {
      return;
    }
    const current = draft;
    void (async () => {
      const result = await optimize(current);
      if (result) {
        previousDraftRef.current = current;
        setOptimizedText(result);
        onReplace(result);
      }
    })();
  }, [draft, isOptimizing, onReplace, optimize]);

  const handleUndo = useCallback(() => {
    const previous = previousDraftRef.current;
    previousDraftRef.current = null;
    setOptimizedText(null);
    if (previous !== null) {
      onReplace(previous);
    }
  }, [onReplace]);

  const showUndo = optimizedText !== null && draft === optimizedText;
  if (!supported || (!showUndo && draft.trim().length === 0)) {
    return null;
  }

  if (isOptimizing) {
    return (
      <Pressable style={styles.button} disabled testID="prompt-optimize-loading">
        <LoadingSpinner size="small" color={styles.icon.color} />
      </Pressable>
    );
  }

  if (showUndo) {
    return (
      <Pressable
        style={styles.button}
        onPress={handleUndo}
        disabled={disabled}
        hitSlop={8}
        accessibilityLabel={t("promptOptimize.undo")}
        testID="prompt-optimize-undo"
      >
        <Undo2 size={styles.icon.width} color={styles.icon.color} />
      </Pressable>
    );
  }

  return (
    <Pressable
      style={styles.button}
      onPress={handleOptimize}
      disabled={disabled}
      hitSlop={8}
      accessibilityLabel={t("promptOptimize.action")}
      testID="prompt-optimize"
    >
      <Sparkles size={styles.icon.width} color={styles.icon.color} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  icon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.sm,
  },
}));
