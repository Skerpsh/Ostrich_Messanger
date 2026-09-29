import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// The website's light/dark switch.
export default function ThemeToggle() {
  const { mode, colors, toggleTheme } = useAppTheme();
  const isLight = mode === "light";

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: isLight }}
      accessibilityLabel={
        isLight ? "Switch to dark theme" : "Switch to light theme"
      }
      onPress={toggleTheme}
      hitSlop={8}
      style={[
        styles.track,
        { backgroundColor: colors.panelAlt, borderColor: colors.line },
      ]}
    >
      <View
        style={[
          styles.thumb,
          { backgroundColor: colors.text },
          isLight && styles.thumbLight,
        ]}
      >
        <Text style={[styles.icon, { color: colors.bg }]}>
          {isLight ? "☀" : "☾"}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 52,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
  },

  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: 3,
    alignItems: "center",
    justifyContent: "center",
  },

  thumbLight: {
    marginLeft: 27,
  },

  icon: {
    fontSize: 12,
    lineHeight: 14,
  },
});
