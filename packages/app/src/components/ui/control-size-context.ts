import { createContext, useContext } from "react";
import type { ButtonControlSize } from "@/components/ui/control-geometry";

/**
 * Default control size for a subtree. `AdaptiveModalSheet` provides this around
 * its sticky footer so action buttons render compact on desktop (and full-size
 * on mobile for touch) without every sheet threading a `size` prop. Buttons that
 * pass an explicit `size` still win. `null` = no override (Button falls back to
 * its own default).
 */
export const ControlSizeContext = createContext<ButtonControlSize | null>(null);

export function useControlSize(): ButtonControlSize | null {
  return useContext(ControlSizeContext);
}
