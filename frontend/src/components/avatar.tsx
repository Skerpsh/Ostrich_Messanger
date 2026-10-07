import { StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";

export default function Avatar({
  name,
  size = 48,
  online = false,
  // Background behind the online dot's ring (the surface the avatar is on).
  ringColor,
}: {
  name: string;
  size?: number;
  // Shows the green "online" dot.
  online?: boolean;
  ringColor?: string;
}) {
  const { colors } = useAppTheme();
  const dot = Math.max(10, Math.round(size * 0.28));

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.panelAlt,
        },
      ]}
    >
      <Text
        style={[styles.letter, { color: colors.textSoft, fontSize: size * 0.4 }]}
      >
        {name.charAt(0).toUpperCase() || "?"}
      </Text>

      {online ? (
        <View
          accessibilityLabel="online"
          style={[
            styles.dot,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: colors.online,
              borderColor: ringColor ?? colors.surface,
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
  },

  letter: {
    fontWeight: "700",
  },

  dot: {
    position: "absolute",
    right: 0,
    bottom: 0,
    borderWidth: 2,
  },
});
