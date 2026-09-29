// Palette of the Ostrich website (style_text.css), dark theme by default.

export type ThemeMode = "dark" | "light";

export type ThemeColors = {
  bg: string;
  bgSoft: string;
  panel: string;
  panelAlt: string;
  text: string;
  textSoft: string;
  muted: string;
  line: string;
  header: string;
  buttonBg: string;
  buttonText: string;
  shadow: string;
  danger: string;
  online: string;
};

export const themes: Record<ThemeMode, ThemeColors> = {
  dark: {
    bg: "#111111",
    bgSoft: "#181818",
    panel: "#1d1d1d",
    panelAlt: "#222222",
    text: "#ffffff",
    textSoft: "#d0d0d0",
    muted: "#a6a6a6",
    line: "rgba(255, 255, 255, 0.12)",
    header: "#000000",
    buttonBg: "#ffffff",
    buttonText: "#111111",
    shadow: "rgba(0, 0, 0, 0.22)",
    danger: "#ff6b6b",
    online: "#4cd964",
  },
  light: {
    bg: "#f3f3f3",
    bgSoft: "#ececec",
    panel: "#ffffff",
    panelAlt: "#f5f5f5",
    text: "#111111",
    textSoft: "#2d2d2d",
    muted: "#5e5e5e",
    line: "rgba(0, 0, 0, 0.08)",
    header: "#ffffff",
    buttonBg: "#111111",
    buttonText: "#ffffff",
    shadow: "rgba(0, 0, 0, 0.08)",
    danger: "#c62828",
    online: "#2e7d32",
  },
};

// Corner radii used by the website.
export const radius = {
  card: 18,
  pill: 999,
};
