import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getItem, setItem } from "@/lib/storage";
import { themes, type ThemeColors, type ThemeMode } from "@/theme/colors";

// Same key as the website uses for its theme toggle.
const THEME_KEY = "ostrich-theme";

type ThemeContextValue = {
  mode: ThemeMode;
  colors: ThemeColors;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    getItem(THEME_KEY).then((saved) => {
      if (saved === "light" || saved === "dark") {
        setMode(saved);
      }
    });
  }, []);

  const toggleTheme = () => {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    setItem(THEME_KEY, next);
  };

  return (
    <ThemeContext value={{ mode, colors: themes[mode], toggleTheme }}>
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
