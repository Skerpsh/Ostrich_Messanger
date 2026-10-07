import { useCallback, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { getChats, type Chat } from "@/lib/api";
import { formatChatDate, formatPresence } from "@/lib/format";
import { rememberPeer } from "@/lib/peers";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { radius } from "@/theme/colors";

export default function ChatsScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { withToken, signOut } = useAuth();
  const user = useCurrentUser();
  const { presence, seedPresence } = useRealtime();
  useMinuteTick();

  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await withToken(getChats);

      seedPresence(
        loaded.map((chat) => ({
          userId: chat.user_id,
          presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
        })),
      );
      setChats(loaded);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chats");
    }
  }, [withToken, seedPresence]);

  // Reload whenever the screen is shown, e.g. after leaving a chat.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const copyUsername = async () => {
    if (!user) {
      return;
    }

    await Clipboard.setStringAsync(`@${user.username}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const openChat = (chat: Chat) => {
    rememberPeer(chat.id, {
      userId: chat.user_id,
      username: chat.username,
    });
    router.push({ pathname: "/chats/[chatId]", params: { chatId: chat.id } });
  };

  if (!user) {
    return null;
  }

  return (
    <View style={styles.screen}>
      <AppHeader
        subtitle={`@${user.username}`}
        right={
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/settings")}
              hitSlop={8}
            >
              <Text style={[styles.headerLink, { color: colors.text }]}>
                Settings
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={signOut} hitSlop={8}>
              <Text style={[styles.headerLink, { color: colors.text }]}>
                Log out
              </Text>
            </Pressable>
          </>
        }
      />

      <FlatList
        data={chats ?? []}
        keyExtractor={(chat) => chat.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + 100 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.text}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Pressable
              onPress={copyUsername}
              accessibilityRole="button"
              accessibilityLabel="Copy your username"
              style={[
                styles.idCard,
                { backgroundColor: colors.panel, borderColor: colors.line },
              ]}
            >
              <Text style={[styles.eyebrow, { color: colors.muted }]}>
                Your username
              </Text>
              <Text selectable style={[styles.username, { color: colors.text }]}>
                @{user.username}
              </Text>
              <Text style={[styles.hint, { color: colors.muted }]}>
                {copied ? "Copied!" : "Tap to copy · share it to start a chat"}
              </Text>
            </Pressable>

            <View style={styles.sectionRow}>
              <Text style={[styles.section, { color: colors.text }]}>
                Chats
              </Text>
              {Platform.OS === "web" ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={refresh}
                  hitSlop={8}
                >
                  <Text style={[styles.headerLink, { color: colors.muted }]}>
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {error ? (
              <Text style={[styles.error, { color: colors.danger }]}>
                {error}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          chats === null ? (
            <ActivityIndicator color={colors.text} style={styles.empty} />
          ) : (
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No chats yet.{"\n"}Start one with a friend&apos;s @username.
            </Text>
          )
        }
        renderItem={({ item }) => {
          const peer = presence[item.user_id];

          return (
            <Pressable
              onPress={() => openChat(item)}
              style={({ pressed, hovered }) => [
                styles.chat,
                {
                  backgroundColor:
                    pressed || hovered ? colors.panelAlt : colors.panel,
                  borderColor: colors.line,
                },
              ]}
            >
              <Avatar name={item.username} online={peer?.online} />
              <View style={styles.chatText}>
                <Text
                  numberOfLines={1}
                  style={[styles.chatName, { color: colors.text }]}
                >
                  {item.username}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.chatMeta, { color: colors.muted }]}
                >
                  {peer ? (
                    <Text style={peer.online && { color: colors.online }}>
                      {formatPresence(peer)}
                      {"  ·  "}
                    </Text>
                  ) : null}
                  @{item.username}
                </Text>
              </View>
              <Text style={[styles.chatMeta, { color: colors.muted }]}>
                {formatChatDate(item.updated_at)}
              </Text>
            </Pressable>
          );
        }}
      />

      <View
        style={[styles.fabArea, { paddingBottom: insets.bottom + 20 }]}
        pointerEvents="box-none"
      >
        <Button title="New chat" onPress={() => router.push("/chats/new")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  headerLink: {
    fontSize: 14,
    fontWeight: "600",
  },

  list: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    padding: 16,
    gap: 10,
  },

  listHeader: {
    gap: 16,
    marginBottom: 6,
  },

  idCard: {
    borderRadius: radius.card,
    borderWidth: 1,
    padding: 20,
    gap: 6,
  },

  eyebrow: {
    fontSize: 12,
    letterSpacing: 3,
    textTransform: "uppercase",
  },

  username: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 1,
    fontVariant: ["tabular-nums"],
  },

  hint: {
    fontSize: 13,
  },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },

  section: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 1,
  },

  error: {
    fontSize: 14,
  },

  empty: {
    marginTop: 40,
  },

  emptyText: {
    marginTop: 40,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 24,
  },

  chat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderRadius: radius.card,
    borderWidth: 1,
  },

  chatText: {
    flex: 1,
    gap: 3,
  },

  chatName: {
    fontSize: 17,
    fontWeight: "600",
  },

  chatMeta: {
    fontSize: 13,
  },

  fabArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
  },
});
