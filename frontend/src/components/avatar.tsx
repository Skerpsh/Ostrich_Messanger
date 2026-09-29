import { StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";

export default function Avatar({
  name,
  size = 46,
  online = false,
}: {
  name: string;
  size?: number;
  // Shows the green "online" dot.
  online?: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.panelAlt,
          borderColor: colors.line,
        },
      ]}
    >
      <Text
        style={[styles.letter, { color: colors.text, fontSize: size * 0.42 }]}
      >
        {name.charAt(0).toUpperCase() || "?"}
      </Text>

      {online ? (
        <View
          accessibilityLabel="online"
          style={[
            styles.dot,
            {
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: size * 0.15,
              backgroundColor: colors.online,
              borderColor: colors.bg,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },

  letter: {
    fontWeight: "700",
  },

  dot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    borderWidth: 2,
  },
});
