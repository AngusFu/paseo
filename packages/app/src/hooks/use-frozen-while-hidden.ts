import { useRef } from "react";

/**
 * Hold a value steady while a sheet/modal is animating closed.
 *
 * On web, `AdaptiveModalSheet` stays mounted for its fade-out after `visible`
 * flips false, and parents typically null their form state on close. Reading
 * that nulled state during the exit animation makes the footer flash to a
 * different layout (e.g. edit → create). This tracks `value` only while
 * `visible` is true and returns the last visible value while hidden.
 */
export function useFrozenWhileHidden<T>(visible: boolean, value: T): T {
  const ref = useRef(value);
  if (visible) {
    ref.current = value;
  }
  return ref.current;
}
