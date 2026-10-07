import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import { getItem, setItem } from "@/lib/storage";
import {
  accents,
  DEFAULT_ACCENT,
  themeColors,
  type AccentId,
  type ThemeColors,
  type ThemeMode,
} from "@/theme/colors";

// Same key as the website uses for its theme toggle.
const THEME_KEY = "ostrich-theme";
// Per device, like the theme.
const ACCENT_KEY = "ostrich-accent";

// "system" follows the device's light/dark setting.
export type ThemePreference = ThemeMode | "system";

type ThemeContextValue = {
  // The theme in use.
  mode: ThemeMode;
  colors: ThemeColors;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  // Switches between light and dark (leaves "system").
  toggleTheme: () => void;
  accentId: AccentId;
  setAccent: (accentId: AccentId) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [accentId, setAccentState] = useState<AccentId>(DEFAULT_ACCENT);

  useEffect(() => {
    getItem(THEME_KEY).then((saved) => {
      if (saved === "light" || saved === "dark" || saved === "system") {
        setPreferenceState(saved);
      }
    });

    getItem(ACCENT_KEY).then((saved) => {
      const known = accents.find((accent) => accent.id === saved);

      if (known) {
        setAccentState(known.id);
      }
    });
  }, []);

  const mode: ThemeMode =
    preference === "system"
      ? systemScheme === "light"
        ? "light"
        : "dark"
      : preference;

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    setItem(THEME_KEY, next);
  };

  const toggleTheme = () => setPreference(mode === "dark" ? "light" : "dark");

  const setAccent = (next: AccentId) => {
    setAccentState(next);
    setItem(ACCENT_KEY, next);
  };

  return (
    <ThemeContext
      value={{
        mode,
        colors: themeColors(mode, accentId),
        preference,
        setPreference,
        toggleTheme,
        accentId,
        setAccent,
      }}
    >
      {children}
    </ThemeContext>
  );
}

export function useAppTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useAppTheme must be used inside AppThemeProvider");
  }

  return context;
}
