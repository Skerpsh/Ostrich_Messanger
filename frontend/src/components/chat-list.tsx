import { useMemo, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { usePathname, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import ActionMenu from "@/components/action-menu";
import Avatar from "@/components/avatar";
import DevBadge from "@/components/dev-badge";
import IconButton from "@/components/icon-button";
import { noWebOutline } from "@/components/text-field";
import { useCurrentUser } from "@/context/auth";
import { useChats } from "@/context/chats";
import { useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import type { Chat } from "@/lib/api";
import { formatChatDate, previewText } from "@/lib/format";
import { messagePreview } from "@/lib/preview";
import { useIsWide } from "@/lib/layout";
import { useChatCrypto } from "@/lib/use-chat-crypto";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { useStartChat } from "@/lib/use-start-chat";
import { cleanUsername, USERNAME_RE } from "@/lib/validation";
import { radius } from "@/theme/colors";

// The chats list: a screen on phones, the left column on wide screens.
export default function ChatList() {
  const router = useRouter();
  const pathname = usePathname();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const user = useCurrentUser();
  const { chats, error, reload, typing, updateChatSettings, removeChat, drafts } = useChats();
  const startChatWith = useStartChat();
  // The chat whose actions are shown (long press / right click).
  const [menuFor, setMenuFor] = useState<Chat | null>(null);
  // A failed pin, mute or delete from that menu.
  const [actionError, setActionError] = useState<string | null>(null);
  const { status, presence } = useRealtime();
  useMinuteTick();

  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // The chat open on the right (wide screens).
  const selectedId = pathname.match(/^\/chats\/([0-9a-f-]{36})$/)?.[1];

  // "@alice" and "alice" both work.
  const search = cleanUsername(query).toLowerCase();

  const shown = useMemo(
    () =>
      (chats ?? []).filter((chat) =>
        chat.username.toLowerCase().includes(search),
      ),
    [chats, search],
  );

  // Offer to start a chat when the search is a username not in the list.
  const canStart =
    USERNAME_RE.test(search) &&
    search !== user?.username.toLowerCase() &&
    !(chats ?? []).some((chat) => chat.username.toLowerCase() === search);

  const go = (path: Parameters<typeof router.push>[0]) =>
    wide ? router.replace(path) : router.push(path);

  const openChat = (chat: Chat) => {
    setQuery("");
    go({ pathname: "/chats/[chatId]", params: { chatId: chat.id } });
  };

  const startChat = async () => {
    setStarting(true);
    setStartError(null);

    try {
      openChat(await startChatWith(search));
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Failed to start chat");
    } finally {
      setStarting(false);
    }
  };

  // Runs an action from the chat menu, showing its error in the list.
  const runAction = async (action: () => Promise<void>) => {
    setMenuFor(null);
    setActionError(null);

    try {
      await action();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  const deleteChat = (chatId: string, scope: "everyone" | "me") =>
    runAction(async () => {
      await removeChat(chatId, scope);

      if (selectedId === chatId) {
        router.replace("/chats");
      }
    });

  const refresh = async () => {
    setRefreshing(true);
    await reload();
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

  if (!user) {
    return null;
  }

  const settingsOpen = pathname === "/chats/settings";

  return (
    <View style={[styles.screen, { backgroundColor: colors.surface }]}>
      <AppHeader
        left={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => go("/chats/settings")}
            style={({ hovered, pressed }) => [
              styles.profile,
              (hovered || pressed || (wide && settingsOpen)) && {
                backgroundColor: colors.hover,
              },
            ]}
          >
            <Avatar name={user.username} avatarId={user.avatar_id} size={36} />
          </Pressable>
        }
        title="Chats"
        subtitle={
          status === "online"
            ? `@${user.username}`
            : status === "connecting"
              ? "Connecting…"
              : "Waiting for network…"
        }
        right={
          <IconButton
            icon="create-outline"
            label="New chat"
            onPress={() => go("/chats/new")}
          />
        }
      />

      <View style={styles.searchWrap}>
        <View style={[styles.search, { backgroundColor: colors.panelAlt }]}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setStartError(null);
            }}
            placeholder="Search or @username"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => (canStart ? startChat() : undefined)}
            style={[styles.searchInput, { color: colors.text }, noWebOutline]}
          />
          {query ? (
            <IconButton
              icon="close-circle"
              label="Clear search"
              size={18}
              color={colors.muted}
              onPress={() => setQuery("")}
            />
          ) : null}
        </View>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(chat) => chat.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + 16 },
        ]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          Platform.OS === "web" ? undefined : (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.text}
            />
          )
        }
        ListHeaderComponent={
          <>
            {canStart ? (
              <Pressable
                onPress={startChat}
                disabled={starting}
                style={({ hovered, pressed }) => [
                  styles.row,
                  (hovered || pressed) && { backgroundColor: colors.hover },
                ]}
              >
                <View
                  style={[styles.startIcon, { backgroundColor: colors.accentSoft }]}
                >
                  {starting ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Ionicons name="chatbubble-ellipses" size={22} color={colors.accent} />
                  )}
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.name, { color: colors.text }]}>
                    Start a chat with @{search}
                  </Text>
                  <Text style={[styles.preview, { color: startError ? colors.danger : colors.muted }]}>
                    {startError ?? "Find this user by their exact username"}
                  </Text>
                </View>
              </Pressable>
            ) : null}
            {error || actionError ? (
              <Pressable
                onPress={() => setActionError(null)}
                disabled={!actionError}
                accessibilityRole={actionError ? "button" : undefined}
              >
                <Text style={[styles.notice, { color: colors.danger }]}>
                  {actionError ?? error}
                </Text>
              </Pressable>
            ) : null}
          </>
        }
        ListEmptyComponent={
          chats === null ? (
            <ActivityIndicator color={colors.muted} style={styles.loading} />
          ) : search ? (
            canStart ? null : (
              <Text style={[styles.notice, { color: colors.muted }]}>
                No chats match “{query.trim()}”.
              </Text>
            )
          ) : (
            <View style={styles.empty}>
              <Ionicons name="chatbubbles-outline" size={44} color={colors.muted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                No chats yet
              </Text>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                Search for a friend by their @username above, or share yours:
              </Text>
              <Pressable
                onPress={copyUsername}
                accessibilityRole="button"
                style={[styles.chip, { backgroundColor: colors.accentSoft }]}
              >
                <Text style={[styles.chipText, { color: colors.accent }]}>
                  {copied ? "Copied!" : `@${user.username}`}
                </Text>
                {copied ? null : (
                  <Ionicons name="copy-outline" size={15} color={colors.accent} />
                )}
              </Pressable>
            </View>
          )
        }
        renderItem={({ item }) => (
          <ChatRow
            chat={item}
            ownId={user.id}
            online={status === "online" && Boolean(presence[item.user_id]?.online)}
            typing={typing.has(item.id)}
            // Not for the chat on screen: its draft is in the input.
            draft={item.id === selectedId ? undefined : drafts[item.id]}
            selected={wide && item.id === selectedId}
            onPress={() => openChat(item)}
            onMenu={() => setMenuFor(item)}
          />
        )}
      />

      <Modal
        visible={menuFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuFor(null)}
      >
        {menuFor ? (
          <ActionMenu
            title={`@${menuFor.username}`}
            onClose={() => setMenuFor(null)}
            items={[
              {
                icon: menuFor.pinned ? "pin" : "pin-outline",
                label: menuFor.pinned ? "Unpin" : "Pin to top",
                onPress: () => runAction(() =>
                  updateChatSettings(menuFor.id, { pinned: !menuFor.pinned }),
                ),
              },
              {
                icon: menuFor.muted ? "notifications-outline" : "notifications-off-outline",
                label: menuFor.muted ? "Unmute" : "Mute",
                onPress: () => runAction(() =>
                  updateChatSettings(menuFor.id, { muted: !menuFor.muted }),
                ),
              },
              {
                icon: "eye-off-outline",
                label: "Clear history for me",
                confirmLabel: `Clear? @${menuFor.username} keeps the messages`,
                danger: true,
                onPress: () => deleteChat(menuFor.id, "me"),
              },
              {
                icon: "trash-outline",
                label: "Delete for both",
                confirmLabel: "Delete the chat for both of you?",
                danger: true,
                onPress: () => deleteChat(menuFor.id, "everyone"),
              },
            ]}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function ChatRow({
  chat,
  ownId,
  online,
  typing,
  draft,
  selected,
  onPress,
  onMenu,
}: {
  chat: Chat;
  ownId: string;
  online: boolean;
  typing: boolean;
  // Unsent text of the chat.
  draft?: string;
  selected: boolean;
  onPress: () => void;
  // Long press / right click: pin, mute, delete.
  onMenu: () => void;
}) {
  const { colors } = useAppTheme();
  const { decrypt } = useChatCrypto(chat);
  const last = chat.last_message;
  const own = last?.sender_id === ownId;
  const read =
    own &&
    chat.peer_last_read_at !== null &&
    new Date(chat.peer_last_read_at) >= new Date(last!.created_at);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onMenu}
      // Web: right click opens the menu instead of the browser's.
      {...({
        onContextMenu: (event: { preventDefault: () => void }) => {
          event.preventDefault();
          onMenu();
        },
      } as object)}
      accessibilityRole="button"
      accessibilityLabel={`Chat with ${chat.username}${chat.unread_count ? `, ${chat.unread_count} unread` : ""}`}
      style={({ hovered, pressed }) => [
        styles.row,
        selected
          ? { backgroundColor: colors.accentSoft }
          : (hovered || pressed) && { backgroundColor: colors.hover },
      ]}
    >
      <Avatar
        name={chat.username}
        avatarId={chat.avatar_id}
        online={online}
        ringColor={selected ? colors.surface : undefined}
      />
      <View style={styles.rowText}>
        <View style={styles.rowLine}>
          <View style={styles.nameWrap}>
            <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
              {chat.username}
            </Text>
            {chat.is_developer ? <DevBadge /> : null}
            {chat.muted ? (
              <Ionicons
                name="notifications-off"
                size={14}
                color={colors.muted}
                accessibilityLabel="muted"
              />
            ) : null}
          </View>
          <View style={styles.meta}>
            {own ? (
              <Ionicons
                name={read ? "checkmark-done" : "checkmark"}
                size={16}
                color={read ? colors.accent : colors.muted}
              />
            ) : null}
            <Text style={[styles.time, { color: chat.unread_count ? colors.accent : colors.muted }]}>
              {formatChatDate(last?.created_at ?? chat.created_at)}
            </Text>
          </View>
        </View>
        <View style={styles.rowLine}>
          <Text numberOfLines={1} style={[styles.preview, { color: colors.muted }]}>
            {typing ? (
              <Text style={{ color: colors.accent }}>typing…</Text>
            ) : draft ? (
              <>
                <Text style={{ color: colors.danger }}>Draft: </Text>
                {previewText(draft)}
              </>
            ) : last ? (
              <>
                {own ? <Text style={{ color: colors.textSoft }}>You: </Text> : null}
                {previewText(messagePreview(decrypt(last)))}
              </>
            ) : (
              <Text style={styles.italic}>No messages yet</Text>
            )}
          </Text>
          {chat.pinned && chat.unread_count === 0 ? (
            <Ionicons name="pin" size={14} color={colors.muted} accessibilityLabel="pinned" />
          ) : null}
          {chat.unread_count > 0 ? (
            <View
              style={[
                styles.badge,
                // Muted chats count quietly.
                { backgroundColor: chat.muted ? colors.muted : colors.accent },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  { color: chat.muted ? colors.bg : colors.onAccent },
                ]}
              >
                {chat.unread_count > 99 ? "99+" : chat.unread_count}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  profile: {
    borderRadius: radius.pill,
    padding: 2,
    marginLeft: 2,
  },

  searchWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },

  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 42,
    borderRadius: radius.input,
    paddingLeft: 12,
    paddingRight: 4,
  },

  searchInput: {
    flex: 1,
    height: "100%",
    fontSize: 15,
  },

  list: {
    paddingHorizontal: 6,
    paddingTop: 4,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 14,
  },

  startIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },

  rowText: {
    flex: 1,
    gap: 3,
  },

  rowLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  nameWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  name: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "600",
  },

  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },

  time: {
    fontSize: 12,
  },

  preview: {
    flex: 1,
    fontSize: 14,
  },

  italic: {
    fontStyle: "italic",
  },

  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },

  badgeText: {
    fontSize: 12,
    fontWeight: "700",
  },

  notice: {
    textAlign: "center",
    fontSize: 14,
    padding: 16,
  },

  loading: {
    marginTop: 40,
  },

  empty: {
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 32,
    paddingTop: 56,
  },

  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
  },

  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    marginTop: 4,
  },

  chipText: {
    fontSize: 15,
    fontWeight: "600",
  },
});
