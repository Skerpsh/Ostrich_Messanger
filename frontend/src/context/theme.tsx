import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import { getItem, setItem } from "@/lib/storage";
import { themes, type ThemeColors, type ThemeMode } from "@/theme/colors";

// Same key as the website uses for its theme toggle.
const THEME_KEY = "ostrich-theme";

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
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  useEffect(() => {
    getItem(THEME_KEY).then((saved) => {
      if (saved === "light" || saved === "dark" || saved === "system") {
        setPreferenceState(saved);
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

  return (
    <ThemeContext
      value={{
        mode,
        colors: themes[mode],
        preference,
        setPreference,
        toggleTheme,
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
