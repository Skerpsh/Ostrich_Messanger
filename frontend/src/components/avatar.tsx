import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";
import { avatarUrl } from "@/lib/api";

export default function Avatar({
  name,
  avatarId,
  size = 48,
  online = false,
  // Background behind the online dot's ring (the surface the avatar is on).
  ringColor,
}: {
  name: string;
  // The profile picture; the first letter of the name without one.
  avatarId?: string | null;
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
      {avatarId ? (
        <Image
          source={{ uri: avatarUrl(avatarId) }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="cover"
          // The URL changes with every upload, so caching is safe.
          cachePolicy="memory-disk"
          transition={120}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text
          style={[
            styles.letter,
            { color: colors.textSoft, fontSize: size * 0.4 },
          ]}
        >
          {name.charAt(0).toUpperCase() || "?"}
        </Text>
      )}

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
