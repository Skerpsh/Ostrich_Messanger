import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

type ButtonProps = Omit<PressableProps, "style"> & {
  title: string;
  // "primary" is the website's .btn; "secondary" is its outlined variant.
  variant?: "primary" | "secondary";
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function Button({
  title,
  variant = "primary",
  loading = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const { colors } = useAppTheme();

  const filled = variant === "primary";
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={inactive}
      style={({ pressed, hovered }) => {
        // Like .btn:hover on the website: colors invert.
        const inverted = !inactive && (pressed || hovered) ? !filled : filled;

        return [
          styles.button,
          {
            backgroundColor: inverted ? colors.buttonBg : "transparent",
            borderColor: filled || inverted ? colors.buttonBg : colors.text,
            shadowColor: colors.shadow,
          },
          inactive && styles.inactive,
          style,
        ];
      }}
      {...props}
    >
      {({ pressed, hovered }) => {
        const inverted = !inactive && (pressed || hovered) ? !filled : filled;
        const textColor = inverted ? colors.buttonText : colors.text;

        return loading ? (
          <ActivityIndicator color={textColor} />
        ) : (
          <Text style={[styles.text, { color: textColor }]}>{title}</Text>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    paddingHorizontal: 35,
    borderRadius: radius.pill,
    borderWidth: 2,
    justifyContent: "center",
    alignItems: "center",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
  },

  inactive: {
    opacity: 0.5,
  },

  text: {
    fontSize: 16,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
