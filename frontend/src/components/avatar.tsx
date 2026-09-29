import { StyleSheet, Text, View } from "react-native";
import { useAppTheme } from "@/context/theme";

export default function Avatar({
  name,
  size = 46,
}: {
  name: string;
  size?: number;
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
});
