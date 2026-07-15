import { useMemo, type CSSProperties } from "react";
import type { TranscriptZoomLayerProps } from "./transcript-zoom-layer";

export type { TranscriptZoomLayerProps } from "./transcript-zoom-layer";

// Web/Electron: wrap the whole transcript in a CSS `zoom`-scaled layer. Unlike
// `transform: scale()`, `zoom` reflows content (text re-wraps, no horizontal
// overflow) and scales everything uniformly, so the virtualized scroller inside
// keeps consistent scroll math. `flex: 1` + `minHeight: 0` preserve the inner
// scroll viewport's own flex sizing.
export function TranscriptZoomLayer({ zoom, children }: TranscriptZoomLayerProps) {
  const style = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      flex: 1,
      minHeight: 0,
      zoom,
    }),
    [zoom],
  );
  return <div style={style}>{children}</div>;
}
