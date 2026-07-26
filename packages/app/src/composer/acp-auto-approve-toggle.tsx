import { memo, useCallback, useMemo } from "react";
import {
  Pressable,
  Text,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ShieldCheck } from "lucide-react-native";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { ACP_AUTO_ACCEPT_FEATURE_ID } from "@/composer/acp-auto-approve";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getFeatureTooltip } from "@/composer/agent-controls/utils";
import type { Theme } from "@/styles/theme";

interface AcpAutoApproveToggleProps {
  feature: AgentFeature & { type: "toggle" };
  disabled?: boolean;
  onToggle: () => void;
}

const ThemedShieldCheck = withUnistyles(ShieldCheck);

const iconEnabledMapping = (theme: Theme) => ({
  color: theme.colors.palette.white,
});
const iconDisabledMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function resolveToggleStyle(
  enabled: boolean,
  disabled: boolean,
  pressed: boolean,
  hovered: boolean,
): StyleProp<ViewStyle> {
  return [
    styles.toggle,
    enabled ? styles.toggleEnabled : null,
    !enabled && (pressed || hovered) && !disabled ? styles.toggleHovered : null,
    disabled ? styles.toggleDisabled : null,
    enabled && (pressed || hovered) && !disabled ? styles.toggleEnabledActive : null,
  ];
}

export const AcpAutoApproveToggle = memo(function AcpAutoApproveToggle({
  feature,
  disabled = false,
  onToggle,
}: AcpAutoApproveToggleProps) {
  const enabled = feature.value === true;
  const tooltip = getFeatureTooltip(feature);
  const accessibilityState = useMemo(() => ({ checked: enabled, disabled }), [disabled, enabled]);

  const pressableStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) =>
      resolveToggleStyle(enabled, disabled, pressed, hovered),
    [disabled, enabled],
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          onPress={onToggle}
          disabled={disabled}
          style={pressableStyle}
          accessibilityRole="switch"
          accessibilityState={accessibilityState}
          accessibilityLabel={tooltip}
          testID="composer-acp-auto-approve-toggle"
        >
          <ThemedShieldCheck
            size={16}
            uniProps={enabled ? iconEnabledMapping : iconDisabledMapping}
          />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

export function findAutoAcceptToggleFeature(
  features: AgentFeature[] | undefined,
): (AgentFeature & { type: "toggle" }) | null {
  const feature = features?.find(
    (entry) => entry.id === ACP_AUTO_ACCEPT_FEATURE_ID && entry.type === "toggle",
  );
  return feature?.type === "toggle" ? feature : null;
}

const styles = StyleSheet.create((theme) => ({
  toggle: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleHovered: {
    backgroundColor: theme.colors.surface2,
  },
  toggleEnabled: {
    backgroundColor: theme.colors.palette.green[600],
  },
  toggleEnabledActive: {
    opacity: 0.9,
  },
  toggleDisabled: {
    opacity: 0.5,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
