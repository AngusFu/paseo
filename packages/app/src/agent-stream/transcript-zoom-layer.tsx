import type { ReactNode } from "react";

export interface TranscriptZoomLayerProps {
  zoom: number;
  children: ReactNode;
}

// Native/base implementation: transcript zoom is web-only (it relies on the CSS
// `zoom` property), so here we pass children straight through untouched. Metro
// resolves the `.web.tsx` sibling for the web/Electron build.
export function TranscriptZoomLayer({ children }: TranscriptZoomLayerProps): ReactNode {
  return children;
}
