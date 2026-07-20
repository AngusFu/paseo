import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { segmentUserMessage } from "@/utils/user-message-segments";
import { baseColors } from "@/styles/theme";

// Hoisted out of StyleSheet.create: the unistyles babel plugin does not resolve
// imported member expressions referenced inside the create callback.
const LINK_COLOR = baseColors.blue[500];

// A read-only layer drawn on top of the composer's TextInput. It renders the
// exact same text with identical font metrics, but paints only the special
// tokens (leading slash-command, URLs) in color and leaves the rest fully
// transparent — so the TextInput's own text (including IME composition) stays
// visible underneath and only the highlighted tokens are tinted over it.
//
// Alignment depends on the overlay matching the TextInput's font-size,
// line-height, weight, padding (0), width and wrapping exactly; the shared
// theme tokens below mirror `styles.textInput` in input.tsx.
export function ComposerHighlightOverlay({
  value,
  scrollTop,
}: {
  value: string;
  scrollTop: number;
}) {
  const segments = useMemo(() => {
    let offset = 0;
    return segmentUserMessage(value).map((segment) => {
      const key = `${offset}-${segment.kind}`;
      offset += segment.text.length;
      return { key, segment };
    });
  }, [value]);

  const overlayTextStyle = useMemo(
    () => [styles.overlayText, { transform: [{ translateY: -scrollTop }] }],
    [scrollTop],
  );

  // Nothing to highlight -> render nothing (avoids covering the plain input).
  const hasHighlight = segments.some((entry) => entry.segment.kind !== "plain");
  if (!hasHighlight) {
    return null;
  }

  return (
    <View style={styles.overlay} pointerEvents="none" aria-hidden>
      <Text style={overlayTextStyle}>
        {segments.map(({ key, segment }) => (
          <Text key={key} style={getStyleByKind(segment.kind)}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
  overlayText: {
    width: "100%",
    // Mirror styles.textInput metrics so glyphs land exactly over the input.
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.base * 1.4,
    // Base color transparent: plain text shows through from the TextInput below.
    color: "transparent",
    // Match a textarea's wrapping so line breaks line up with the input.
    whiteSpace: "pre-wrap" as const,
    overflowWrap: "anywhere" as const,
  },
  plain: {
    color: "transparent",
  },
  command: {
    // No fontWeight override: the overlay paints over the TextInput's own text,
    // so any width difference (e.g. a bolder weight) drifts the tint off the
    // glyphs. Keep the normal weight and tint by color only.
    color: theme.colors.statusWarning,
  },
  url: {
    color: LINK_COLOR,
  },
}));

// Resolved lazily — module-scope `styles.*` reads materialize the pre-persistence theme.
function getStyleByKind(kind: "plain" | "command" | "url") {
  const map = {
    plain: styles.plain,
    command: styles.command,
    url: styles.url,
  } as const;
  return map[kind];
}
