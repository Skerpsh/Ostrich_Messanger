import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Pressable, StyleSheet, Text, View } from "react-native";
import ChatList from "@/components/chat-list";
import { useCurrentUser } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { useIsWide } from "@/lib/layout";
import { radius } from "@/theme/colors";

export default function ChatsScreen() {
  const wide = useIsWide();

  // Wide screens show the list in the sidebar; this is the empty right pane.
  return wide ? <NoChatSelected /> : <ChatList />;
}

function NoChatSelected() {
  const { colors } = useAppTheme();
  const user = useCurrentUser();
  const [copied, setCopied] = useState(false);

  if (!user) {
    return null;
  }

  const copy = async () => {
    await Clipboard.setStringAsync(`@${user.username}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={styles.screen}>
      <Image
        source={require("@/assets/images/Giuseppe.png")}
        style={styles.logo}
        contentFit="contain"
        accessibilityLabel="Ostrich"
      />
      <Text style={[styles.title, { color: colors.text }]}>
        Select a chat to start messaging
      </Text>
      <Text style={[styles.text, { color: colors.muted }]}>
        Friends can find you by your username:
      </Text>
      <Pressable
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel="Copy your username"
        style={({ hovered }) => [
          styles.chip,
          { backgroundColor: colors.accentSoft },
          hovered && styles.chipHover,
        ]}
      >
        <Text style={[styles.chipText, { color: colors.accent }]}>
          {copied ? "Copied!" : `@${user.username}`}
        </Text>
        {copied ? null : (
          <Ionicons name="copy-outline" size={15} color={colors.accent} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },

  logo: {
    width: 96,
    height: 96,
    opacity: 0.9,
    marginBottom: 6,
  },

  title: {
    fontSize: 18,
    fontWeight: "700",
  },

  text: {
    fontSize: 14,
  },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },

  chipHover: {
    opacity: 0.85,
  },

  chipText: {
    fontSize: 15,
    fontWeight: "600",
  },
});
