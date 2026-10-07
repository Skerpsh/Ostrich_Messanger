// Monochrome palette of the Ostrich website plus one accent color (own
// messages, primary buttons, unread badges, selection). Contrast checked
// against WCAG AA for the text drawn on each surface.

export type ThemeMode = "dark" | "light";

export type ThemeColors = {
  // Page background (chat area).
  bg: string;
  // Sidebar, headers, composer.
  surface: string;
  // Cards, other people's bubbles, inputs.
  panel: string;
  panelAlt: string;
  // Hover / pressed rows.
  hover: string;
  text: string;
  textSoft: string;
  muted: string;
  line: string;
  accent: string;
  // Text and icons drawn on the accent color.
  onAccent: string;
  // Subtle accent background, e.g. the selected chat.
  accentSoft: string;
  shadow: string;
  danger: string;
  online: string;
};

export const themes: Record<ThemeMode, ThemeColors> = {
  dark: {
    bg: "#0f0f10",
    surface: "#151517",
    panel: "#1c1c1f",
    panelAlt: "#26262a",
    hover: "#202024",
    text: "#f5f5f5",
    textSoft: "#cfcfd4",
    muted: "#8e8e93",
    line: "rgba(255, 255, 255, 0.08)",
    accent: "#ff8a3d",
    onAccent: "#1a0e04",
    accentSoft: "rgba(255, 138, 61, 0.14)",
    shadow: "rgba(0, 0, 0, 0.35)",
    danger: "#ff6b6b",
    online: "#4cd964",
  },
  light: {
    bg: "#f4f4f5",
    surface: "#ffffff",
    panel: "#ffffff",
    panelAlt: "#ececee",
    hover: "#f0f0f2",
    text: "#111113",
    textSoft: "#3a3a3f",
    muted: "#6e6e73",
    line: "rgba(0, 0, 0, 0.08)",
    accent: "#b84e08",
    onAccent: "#ffffff",
    accentSoft: "rgba(184, 78, 8, 0.1)",
    shadow: "rgba(0, 0, 0, 0.08)",
    danger: "#c62828",
    online: "#2e7d32",
  },
};

// Accent colors the user can choose (Settings → Appearance). Each has a
// bright variant for the dark theme (with dark text on it) and a deep one
// for the light theme (with white text on it); all pass WCAG AA (4.5:1)
// for the text on the accent and for the accent on the page background.
export type AccentId =
  | "orange"
  | "red"
  | "pink"
  | "purple"
  | "blue"
  | "teal"
  | "green"
  | "gold"
  | "mono";

type AccentVariant = { accent: string; onAccent: string };

export const accents: {
  id: AccentId;
  name: string;
  dark: AccentVariant;
  light: AccentVariant;
}[] = [
  {
    id: "orange",
    name: "Orange",
    dark: { accent: "#ff8a3d", onAccent: "#1a0e04" },
    light: { accent: "#b84e08", onAccent: "#ffffff" },
  },
  {
    id: "red",
    name: "Red",
    dark: { accent: "#ff7070", onAccent: "#2a0505" },
    light: { accent: "#c0262d", onAccent: "#ffffff" },
  },
  {
    id: "pink",
    name: "Pink",
    dark: { accent: "#ff7ab6", onAccent: "#2b0418" },
    light: { accent: "#b3206a", onAccent: "#ffffff" },
  },
  {
    id: "purple",
    name: "Purple",
    dark: { accent: "#b392ff", onAccent: "#170838" },
    light: { accent: "#6a3cd0", onAccent: "#ffffff" },
  },
  {
    id: "blue",
    name: "Blue",
    dark: { accent: "#5aa9ff", onAccent: "#04162b" },
    light: { accent: "#1c5fc4", onAccent: "#ffffff" },
  },
  {
    id: "teal",
    name: "Teal",
    dark: { accent: "#3ed6c5", onAccent: "#03211d" },
    light: { accent: "#0a756a", onAccent: "#ffffff" },
  },
  {
    id: "green",
    name: "Green",
    dark: { accent: "#6fdc6f", onAccent: "#062006" },
    light: { accent: "#2b7a30", onAccent: "#ffffff" },
  },
  {
    id: "gold",
    name: "Gold",
    dark: { accent: "#f5c542", onAccent: "#2a2000" },
    light: { accent: "#856400", onAccent: "#ffffff" },
  },
  {
    id: "mono",
    name: "Mono",
    dark: { accent: "#f5f5f5", onAccent: "#111113" },
    light: { accent: "#111113", onAccent: "#ffffff" },
  },
];

export const DEFAULT_ACCENT: AccentId = "orange";

// "#rrggbb" → "rgba(r, g, b, alpha)".
function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// The theme's colors with the chosen accent.
export function themeColors(mode: ThemeMode, accentId: AccentId): ThemeColors {
  const accent = accents.find((a) => a.id === accentId) ?? accents[0];
  const variant = accent[mode];

  return {
    ...themes[mode],
    accent: variant.accent,
    onAccent: variant.onAccent,
    accentSoft: withAlpha(variant.accent, mode === "dark" ? 0.14 : 0.1),
  };
}

export const radius = {
  card: 18,
  bubble: 18,
  // The joined corner of consecutive bubbles.
  bubbleJoined: 6,
  input: 14,
  pill: 999,
};

// Width at which the chats list and the open chat are shown side by side
// (tablets, desktop browsers, Mac).
export const WIDE_LAYOUT_MIN_WIDTH = 768;
