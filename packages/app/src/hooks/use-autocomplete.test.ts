// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAutocomplete } from "./use-autocomplete";

describe("useAutocomplete", () => {
  it("clamps a stale out-of-range index while options are present", () => {
    const onSelectOption = vi.fn();
    const { result, rerender } = renderHook(
      ({ options, query }) =>
        useAutocomplete({
          isVisible: true,
          options,
          query,
          onSelectOption,
        }),
      {
        initialProps: {
          options: ["a", "b", "c"],
          query: "",
        },
      },
    );

    expect(result.current.selectedIndex).toBe(2);

    rerender({
      options: ["a"],
      query: "a",
    });

    // Before the effect runs, render-time clamp must already be in range so the
    // popover never sees selectedIndex >= options.length for a frame.
    expect(result.current.selectedIndex).toBe(0);
  });

  it("returns -1 when hidden even if options remain", () => {
    const { result, rerender } = renderHook(
      ({ isVisible }) =>
        useAutocomplete({
          isVisible,
          options: ["a", "b"],
          query: "",
          onSelectOption: vi.fn(),
        }),
      { initialProps: { isVisible: true } },
    );

    expect(result.current.selectedIndex).toBe(1);

    rerender({ isVisible: false });
    expect(result.current.selectedIndex).toBe(-1);
  });

  it("moves selection with arrow keys", () => {
    const { result } = renderHook(() =>
      useAutocomplete({
        isVisible: true,
        options: ["a", "b", "c"],
        query: "",
        onSelectOption: vi.fn(),
      }),
    );

    act(() => {
      result.current.onKeyPress({ key: "ArrowUp", preventDefault: vi.fn() });
    });
    expect(result.current.selectedIndex).toBe(1);
  });
});
