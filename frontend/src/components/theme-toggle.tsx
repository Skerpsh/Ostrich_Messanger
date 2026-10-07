import { useAppTheme } from "@/context/theme";
import IconButton from "./icon-button";

// Light/dark switch for screens without settings (welcome, login). Signed-in
// users choose the theme in Settings, including "same as the system".
export default function ThemeToggle() {
  const { mode, toggleTheme } = useAppTheme();
  const isLight = mode === "light";

  return (
    <IconButton
      icon={isLight ? "moon-outline" : "sunny-outline"}
      label={isLight ? "Switch to dark theme" : "Switch to light theme"}
      onPress={toggleTheme}
      size={20}
    />
  );
}
