/**
 * z-index of react-native-web's <Modal> wrapper (ModalAnimation `container`
 * style, currently hard-coded to 9999). Every Combobox / model-picker popover
 * renders through a react-native-web <Modal>, so each one paints inside a
 * body-level `position:fixed; z-index:9999` stacking context. The overlay root
 * must sit at the SAME z-index so that AdaptiveModalSheet content (also a
 * body-level fixed stacking context) can compete with those pickers on DOM
 * order instead of always losing to their 9999. See raiseOverlayRoot.
 */
const RN_WEB_MODAL_Z_INDEX = 9999;

/**
 * Shared overlay root for web portals (modals, toasts, etc.)
 * This ensures consistent stacking order by controlling a single overlay container.
 *
 * Z-index scale within overlay root:
 * - Modal backdrop/content: 10
 * - Toast: 20
 */
export function getOverlayRoot(): HTMLElement {
  let el = document.getElementById("overlay-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "overlay-root";
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.pointerEvents = "none";
    // Match react-native-web <Modal> (Combobox pickers) so sheets and pickers
    // resolve stacking by DOM order rather than the pickers' fixed 9999.
    el.style.zIndex = String(RN_WEB_MODAL_Z_INDEX);
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Re-append the overlay root to the end of <body> so its portalled content
 * (modal sheets, toasts) stacks above body-level portals created earlier —
 * notably react-native-web <Modal> popovers (the combobox / model-picker
 * pickers), which append their own `position:fixed; z-index:9999` container to
 * <body> on open. The overlay root is pinned to the same z-index (see
 * RN_WEB_MODAL_Z_INDEX), so among these equal-z-index fixed stacking contexts
 * paint order follows DOM order. Moving the overlay root last lifts a sheet
 * opened *after* a picker above that picker (e.g. provider settings opened from
 * the model picker's gear). A picker opened *after* a sheet still appends later
 * and stays on top of it, so nested pickers (e.g. a SelectField inside a modal
 * sheet) still compose correctly.
 */
export function raiseOverlayRoot(): void {
  const el = getOverlayRoot();
  if (document.body.lastChild !== el) {
    document.body.appendChild(el);
  }
}

export const OVERLAY_Z = {
  modal: 10,
  toast: 20,
} as const;
