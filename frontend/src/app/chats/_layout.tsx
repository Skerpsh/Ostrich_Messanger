import { Slot, Stack } from "expo-router";
import { StyleSheet, View } from "react-native";
import ChatList from "@/components/chat-list";
import { useAppTheme } from "@/context/theme";
import { useIsWide, useSidebarWidth } from "@/lib/layout";

// Phones: the chats list, a chat, new chat and settings are separate
// screens. Wide screens: the chats list stays on the left and the rest
// opens on the right.
export default function ChatsLayout() {
  const { colors } = useAppTheme();
  const wide = useIsWide();
  const sidebarWidth = useSidebarWidth();

  if (!wide) {
    return (
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="[chatId]" />
        <Stack.Screen name="new" options={{ presentation: "modal" }} />
        <Stack.Screen name="settings" />
      </Stack>
    );
  }

  return (
    <View style={[styles.split, { backgroundColor: colors.bg }]}>
      <View
        style={[
          styles.sidebar,
          { width: sidebarWidth, borderRightColor: colors.line },
        ]}
      >
        <ChatList />
      </View>
      <View style={styles.pane}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  split: {
    flex: 1,
    flexDirection: "row",
  },

  sidebar: {
    borderRightWidth: StyleSheet.hairlineWidth,
  },

  pane: {
    flex: 1,
  },
});
