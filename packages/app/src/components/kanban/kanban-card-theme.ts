import { CircleDot, GitMerge, Ticket, type LucideIcon } from "lucide-react-native";

export interface KanbanCardThemeVisual {
  icon: LucideIcon;
  // Accent color for the theme glyph. `null` means "use the default muted
  // foreground" — the render layer resolves it against the theme so we never
  // hardcode a grey here.
  color: string | null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Resolve a stored card `theme` string to a glyph + accent color.
 * - "jira" / "gitlab-mr" → a built-in brand-ish icon and color.
 * - "#RRGGBB" → that color as the accent.
 * - anything else → the default muted grey (color: null).
 */
export function resolveKanbanCardTheme(theme: string): KanbanCardThemeVisual {
  if (theme === "jira") {
    return { icon: Ticket, color: "#2684FF" };
  }
  if (theme === "gitlab-mr") {
    return { icon: GitMerge, color: "#FC6D26" };
  }
  if (HEX_COLOR.test(theme)) {
    return { icon: CircleDot, color: theme };
  }
  return { icon: CircleDot, color: null };
}
