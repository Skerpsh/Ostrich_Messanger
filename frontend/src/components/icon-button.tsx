import type { ComponentProps } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useAppTheme } from "@/context/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

type IconButtonProps = {
  icon: IconName;
  // Read by screen readers; also the tooltip on web.
  label: string;
  onPress: () => void;
  size?: number;
  color?: string;
  // Filled accent circle, e.g. the send button.
  filled?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

// A round, icon-only button with a hover/pressed background.
export default function IconButton({
  icon,
  label,
  onPress,
  size = 22,
  color,
  filled = false,
  disabled = false,
  style,
}: IconButtonProps) {
  const { colors } = useAppTheme();
  const box = Math.round(size * 1.85);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // Tooltip on web.
      {...({ title: label } as object)}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed, hovered }) => [
        styles.button,
        { width: box, height: box, borderRadius: box / 2 },
        filled
          ? { backgroundColor: disabled ? colors.panelAlt : colors.accent }
          : (pressed || hovered) && !disabled
            ? { backgroundColor: colors.hover }
            : null,
        pressed && filled && styles.pressed,
        disabled && !filled && styles.disabled,
        style,
      ]}
    >
      <Ionicons
        name={icon}
        size={size}
        color={
          color ??
          (filled ? (disabled ? colors.muted : colors.onAccent) : colors.text)
        }
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
  },

  pressed: {
    opacity: 0.85,
  },

  disabled: {
    opacity: 0.4,
  },
});
