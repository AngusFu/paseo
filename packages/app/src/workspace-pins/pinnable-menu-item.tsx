import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Pin, PinOff } from "lucide-react-native";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { pinnedTargetKey, type PinnedTabTarget } from "@/workspace-pins/target";
import { usePinnedTargetsStore } from "@/workspace-pins/store";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);

interface PinnableMenuItemProps {
  target: PinnedTabTarget;
  label: string;
  leading: ReactElement;
  disabled?: boolean;
  onSelect?: () => void;
  testID?: string;
}

export function PinnableMenuItem({
  target,
  label,
  leading,
  disabled,
  onSelect,
  testID,
}: PinnableMenuItemProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const isPinned = usePinnedTargetsStore((state) => state.isPinned(target));
  const toggle = usePinnedTargetsStore((state) => state.toggle);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const handleTogglePin = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      toggle(target);
    },
    [target, toggle],
  );

  const showToggle = isHovered || isNative || isCompact;

  const slotStyle = useMemo(
    () => [styles.pinToggleSlot, showToggle ? styles.pinToggleShown : styles.pinToggleHidden],
    [showToggle],
  );

  // The menu item is itself pressable, and on web it renders a <button>. Nesting the pin control
  // inside its `trailing` slot would put a button inside a button — invalid DOM that React warns
  // about, and the inner press target is unreliable. The item only reserves the space; the pin
  // control is a sibling laid over that gap.
  const trailingSpacer = useMemo(() => <View style={styles.pinToggleSlot} />, []);

  return (
    <View
      style={styles.container}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <DropdownMenuItem
        testID={testID}
        leading={leading}
        trailing={trailingSpacer}
        disabled={disabled}
        onSelect={onSelect}
      >
        {label}
      </DropdownMenuItem>
      <View style={slotStyle} pointerEvents={showToggle ? "box-none" : "none"}>
        <Pressable
          onPress={handleTogglePin}
          hitSlop={8}
          style={styles.pinToggleButton}
          accessibilityRole="button"
          accessibilityLabel={
            isPinned
              ? t("workspace.tabs.actions.unpinTarget")
              : t("workspace.tabs.actions.pinTarget")
          }
          testID={`workspace-pin-toggle-${pinnedTargetKey(target)}`}
        >
          {isPinned ? (
            <ThemedPinOff size={14} uniProps={mutedColorMapping} />
          ) : (
            <ThemedPin size={14} uniProps={mutedColorMapping} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
  },
  // Sits over the spacer the menu item reserves in its trailing slot; the inset matches the
  // item's own paddingHorizontal so the icon lands exactly where the slot is.
  pinToggleSlot: {
    position: "absolute",
    right: theme.spacing[3],
    top: 0,
    bottom: 0,
    width: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  pinToggleHidden: {
    opacity: 0,
  },
  pinToggleShown: {
    opacity: 1,
  },
  pinToggleButton: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
}));
