// Native/base no-op. Live input highlighting is a web-only overlay (see
// highlight-overlay.web.tsx); React Native's TextInput cannot color ranges, so
// native keeps the plain input.
export function ComposerHighlightOverlay(_props: { value: string; scrollTop: number }): null {
  return null;
}
