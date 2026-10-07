import Ionicons from "@expo/vector-icons/Ionicons";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";
import type { IconName } from "./icon-button";

type ButtonProps = Omit<PressableProps, "style"> & {
  title: string;
  // "primary": accent fill; "secondary": outlined; "danger": red text.
  variant?: "primary" | "secondary" | "danger";
  icon?: IconName;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function Button({
  title,
  variant = "primary",
  icon,
  loading = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const { colors } = useAppTheme();

  const inactive = disabled || loading;
  const textColor =
    variant === "primary"
      ? colors.onAccent
      : variant === "danger"
        ? colors.danger
        : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive) }}
      disabled={inactive}
      style={({ pressed, hovered }) => [
        styles.button,
        variant === "primary"
          ? { backgroundColor: colors.accent, borderColor: colors.accent }
          : {
              backgroundColor:
                (pressed || hovered) && !inactive ? colors.hover : "transparent",
              borderColor: variant === "danger" ? colors.danger : colors.line,
            },
        variant === "primary" && (pressed || hovered) && !inactive && styles.primaryActive,
        inactive && styles.inactive,
        style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ionicons name={icon} size={18} color={textColor} /> : null}
          <Text style={[styles.text, { color: textColor }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 24,
    borderRadius: radius.input,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  primaryActive: {
    opacity: 0.88,
  },

  inactive: {
    opacity: 0.45,
  },

  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  text: {
    fontSize: 16,
    fontWeight: "600",
  },
});
