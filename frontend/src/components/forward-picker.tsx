import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import ChatAvatar from "@/components/chat-avatar";
import DevBadge from "@/components/dev-badge";
import { noWebOutline } from "@/components/text-field";
import { useChats } from "@/context/chats";
import { useAppTheme } from "@/context/theme";
import type { Chat } from "@/lib/api";
import { chatTitle, groupKeyOf } from "@/lib/groups";
import { radius } from "@/theme/colors";

// "Forward to…": a chat to forward a message to, over a dimmed background
// (placed like ActionMenu).
export default function ForwardPicker({
  onPick,
  onClose,
}: {
  onPick: (chat: Chat) => void;
  onClose: () => void;
}) {
  const { colors } = useAppTheme();
  const { chats } = useChats();
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const needle = query.trim().replace(/^@/, "").toLowerCase();

    // Chats that can be written to from here: not blocked, with the other
    // member's key (or the group's).
    return (chats ?? []).filter(
      (chat) =>
        !chat.blocked &&
        (chat.type === "group" ? groupKeyOf(chat.id, chat.key_epoch) : chat.public_key) &&
        chatTitle(chat).toLowerCase().includes(needle),
    );
  }, [chats, query]);

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
      <Pressable style={[styles.card, { backgroundColor: colors.panel }]} onPress={() => {}}>
        <Text style={[styles.title, { color: colors.text }]}>Forward to…</Text>
        <View style={[styles.search, { backgroundColor: colors.panelAlt }]}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats"
            placeholderTextColor={colors.muted}
            autoFocus
            style={[styles.searchInput, { color: colors.text }, noWebOutline]}
          />
        </View>
        <FlatList
          data={shown}
          keyExtractor={(chat) => chat.id}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.muted }]}>No chats to forward to</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPick(item)}
              accessibilityRole="button"
              accessibilityLabel={`Forward to ${chatTitle(item)}`}
              style={({ hovered, pressed }) => [
                styles.row,
                (hovered || pressed) && { backgroundColor: colors.hover },
              ]}
            >
              <ChatAvatar chat={item} size={34} />
              <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>
                {item.type === "group" ? chatTitle(item) : item.username}
              </Text>
              {item.is_developer ? <DevBadge /> : null}
            </Pressable>
          )}
        />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },

  card: {
    width: "100%",
    maxWidth: 360,
    maxHeight: "80%",
    borderRadius: radius.card,
    paddingVertical: 14,
    gap: 10,
  },

  title: {
    fontSize: 17,
    fontWeight: "700",
    paddingHorizontal: 16,
  },

  search: {
    marginHorizontal: 12,
    height: 38,
    borderRadius: radius.input,
    paddingHorizontal: 12,
    justifyContent: "center",
  },

  searchInput: {
    fontSize: 15,
  },

  list: {
    flexGrow: 0,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },

  name: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "600",
  },

  empty: {
    textAlign: "center",
    padding: 16,
  },
});
