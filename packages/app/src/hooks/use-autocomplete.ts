import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAutocompleteFallbackIndex,
  getAutocompleteNextIndex,
  type AutocompleteOptionsPosition,
} from "@/components/ui/autocomplete-utils";

interface UseAutocompleteInput<TOption> {
  isVisible: boolean;
  options: readonly TOption[];
  query: string;
  onSelectOption: (option: TOption) => void;
  onEscape?: () => void;
  optionsPosition?: AutocompleteOptionsPosition;
}

interface UseAutocompleteResult {
  selectedIndex: number;
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean;
}

function clampSelectedIndex(input: {
  isVisible: boolean;
  optionsLength: number;
  selectedIndex: number;
  optionsPosition?: AutocompleteOptionsPosition;
}): number {
  if (!input.isVisible || input.optionsLength === 0) {
    return -1;
  }
  if (input.selectedIndex < 0 || input.selectedIndex >= input.optionsLength) {
    return getAutocompleteFallbackIndex(input.optionsLength, input.optionsPosition);
  }
  return input.selectedIndex;
}

export function useAutocomplete<TOption>(
  input: UseAutocompleteInput<TOption>,
): UseAutocompleteResult {
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const previousQueryRef = useRef("");

  useEffect(() => {
    if (!input.isVisible) {
      previousQueryRef.current = input.query;
      setSelectedIndex(-1);
      return;
    }

    const queryChanged = previousQueryRef.current !== input.query;
    previousQueryRef.current = input.query;

    setSelectedIndex((current) => {
      if (input.options.length === 0) {
        return -1;
      }

      const fallbackIndex = getAutocompleteFallbackIndex(
        input.options.length,
        input.optionsPosition,
      );

      if (queryChanged) {
        return fallbackIndex;
      }
      if (current < 0 || current >= input.options.length) {
        return fallbackIndex;
      }
      return current;
    });
  }, [input.isVisible, input.options.length, input.query, input.optionsPosition]);

  // Clamp during render so a stale -1/OOB index never reaches the popover for a
  // frame (that used to clear the anchor and unmount the portal).
  const resolvedSelectedIndex = clampSelectedIndex({
    isVisible: input.isVisible,
    optionsLength: input.options.length,
    selectedIndex,
    optionsPosition: input.optionsPosition,
  });

  const onKeyPress = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (!input.isVisible || input.options.length === 0) {
        return false;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: input.options.length,
            key: "ArrowUp",
          }),
        );
        return true;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) =>
          getAutocompleteNextIndex({
            currentIndex: current,
            itemCount: input.options.length,
            key: "ArrowDown",
          }),
        );
        return true;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const fallbackIndex = getAutocompleteFallbackIndex(
          input.options.length,
          input.optionsPosition,
        );
        const resolvedIndex =
          selectedIndex >= 0 && selectedIndex < input.options.length
            ? selectedIndex
            : fallbackIndex;
        const selectedOption = input.options[resolvedIndex];
        if (selectedOption) {
          input.onSelectOption(selectedOption);
        }
        return true;
      }

      if (event.key === "Escape" && input.onEscape) {
        event.preventDefault();
        input.onEscape();
        return true;
      }

      return false;
    },
    [input, selectedIndex],
  );

  return {
    selectedIndex: resolvedSelectedIndex,
    onKeyPress,
  };
}
