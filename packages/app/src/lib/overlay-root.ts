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
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Re-append the overlay root to the end of <body> so its portalled content
 * (modal sheets, toasts) stacks above body-level portals created earlier —
 * notably react-native-web <Modal> popovers (the combobox / model-picker
 * pickers) which append their own `position:fixed; z-index:auto` container to
 * <body> on open. Both the overlay root and those modal containers are
 * z-index:auto fixed stacking contexts, so paint order follows DOM order.
 * Moving the overlay root last lifts a sheet opened *after* a picker above
 * that picker. A picker opened *after* a sheet still appends later and stays
 * on top of it, so nested pickers (e.g. a SelectField inside a modal sheet)
 * still compose correctly.
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
