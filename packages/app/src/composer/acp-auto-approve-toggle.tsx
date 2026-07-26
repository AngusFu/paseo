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

interface AcpAutoApproveFloatingToggleProps {
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
    disabled ? styles.toggleDisabled : null,
    (pressed || hovered) && !disabled ? styles.toggleActive : null,
  ];
}

export const AcpAutoApproveFloatingToggle = memo(function AcpAutoApproveFloatingToggle({
  feature,
  disabled = false,
  onToggle,
}: AcpAutoApproveFloatingToggleProps) {
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
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 3,
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  toggleEnabled: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[600],
  },
  toggleDisabled: {
    opacity: 0.5,
  },
  toggleActive: {
    opacity: 0.9,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
