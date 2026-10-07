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
