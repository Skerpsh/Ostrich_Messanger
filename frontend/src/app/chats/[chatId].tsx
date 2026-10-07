import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import { useAuth, useCurrentUser } from "@/context/auth";
import { usePresence, useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { getChats, getMessages, sendMessage, type Message } from "@/lib/api";
import { formatPresence, formatTime } from "@/lib/format";
import { knownPeer, rememberPeer } from "@/lib/peers";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { radius } from "@/theme/colors";

const MAX_MESSAGE_LENGTH = 4096;

// Adds messages, dropping duplicates (a message can arrive both from the
// websocket and from a history reload), oldest first.
function mergeMessages(current: Message[], incoming: Message[]) {
  const byId = new Map(current.map((message) => [message.id, message]));

  for (const message of incoming) {
    byId.set(message.id, message);
  }

  return [...byId.values()].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

export default function ChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { status, subscribeChat, seedPresence } = useRealtime();
  useMinuteTick();

  const { chatId } = useLocalSearchParams<{ chatId: string }>();

  // Known from the chats list when opened in the app; the server's answer
  // below is authoritative either way.
  const [peer, setPeer] = useState(() => knownPeer(chatId));
  const peerPresence = usePresence(peer?.userId);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const inputRef = useRef<TextInput>(null);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  // Look up who the chat is with. Never taken from the URL: anyone can
  // craft a link with a misleading name.
  useEffect(() => {
    withToken(getChats)
      .then((chats) => {
        const chat = chats.find((c) => c.id === chatId);

        if (chat) {
          const verified = {
            userId: chat.user_id,
            username: chat.username,
          };

          rememberPeer(chat.id, verified);
          setPeer(verified);
          seedPresence([
            {
              userId: chat.user_id,
              presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
            },
          ]);
        } else {
          setPeer(null);
          setError("Chat not found");
        }
      })
      .catch((e) => setError(e.message));
  }, [chatId, withToken, seedPresence]);

  const loadHistory = useCallback(async () => {
    try {
      const history = await withToken((t) => getMessages(t, chatId));
      setMessages((current) => mergeMessages(current ?? [], history));
      setError(null);
    } catch (e) {
      setMessages((current) => current ?? []);
      setError(e instanceof Error ? e.message : "Failed to load messages");
    }
  }, [chatId, withToken]);

  // Initial history, also when the realtime connection is down.
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Live updates over the session's connection. History is reloaded after
  // every join, so nothing sent while disconnected is missed.
  useEffect(
    () =>
      subscribeChat(chatId, {
        onJoined: loadHistory,
        onMessage: (message) =>
          setMessages((current) => mergeMessages(current ?? [], [message])),
      }),
    [chatId, subscribeChat, loadHistory],
  );

  const send = async () => {
    const content = draft.trim();

    if (!content || sending) {
      return;
    }

    setSending(true);
    // Clear right away so the user can type the next message meanwhile.
    setDraft("");

    try {
      const message = await withToken((t) => sendMessage(t, chatId, content));
      setMessages((current) => mergeMessages(current ?? [], [message]));
      setError(null);
    } catch (e) {
      // Give the unsent text back unless something new was typed.
      setDraft((current) => current || content);
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // Web: Enter sends, Shift+Enter makes a new line.
  const onKeyPress = (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    const nativeEvent = event.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean;
    };

    if (
      Platform.OS === "web" &&
      nativeEvent.key === "Enter" &&
      !nativeEvent.shiftKey
    ) {
      event.preventDefault();
      send();
    }
  };

  // The list is inverted so it starts at the newest message.
  const reversed = useMemo(() => [...(messages ?? [])].reverse(), [messages]);

  // The peer's presence is only known while we are connected ourselves.
  const peerOnline = status === "online" && Boolean(peerPresence?.online);
  const statusText =
    status === "online"
      ? formatPresence(peerPresence)
      : status === "connecting"
        ? "connecting…"
        : "waiting for network…";

  return (
    <View style={styles.screen}>
      <AppHeader
        onBack={goBack}
        title={peer?.username ?? "…"}
        subtitle={
          <>
            {peerOnline ? (
              <Text style={{ color: colors.online }}>● </Text>
            ) : null}
            {statusText}
            {statusText && peer ? "  ·  " : ""}
            {peer ? `@${peer.username}` : ""}
          </>
        }
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {messages === null ? (
          <ActivityIndicator color={colors.text} style={styles.loader} />
        ) : (
          <FlatList
            inverted
            data={reversed}
            keyExtractor={(message) => message.id}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={[styles.empty, { color: colors.muted }]}>
                No messages yet. Say hi!
              </Text>
            }
            renderItem={({ item }) => {
              const own = item.sender_id === user?.id;

              return (
                <View
                  style={[styles.row, own ? styles.rowOwn : styles.rowOther]}
                >
                  <View
                    style={[
                      styles.bubble,
                      own
                        ? {
                            backgroundColor: colors.buttonBg,
                            borderColor: colors.buttonBg,
                          }
                        : {
                            backgroundColor: colors.panel,
                            borderColor: colors.line,
                          },
                      own ? styles.bubbleOwn : styles.bubbleOther,
                    ]}
                  >
                    <Text
                      selectable
                      style={[
                        styles.content,
                        { color: own ? colors.buttonText : colors.text },
                      ]}
                    >
                      {item.content}
                    </Text>
                    <Text
                      style={[
                        styles.time,
                        { color: own ? colors.buttonText : colors.muted },
                        own && styles.timeOwn,
                      ]}
                    >
                      {formatTime(item.created_at)}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              paddingBottom: insets.bottom + 12,
              backgroundColor: colors.header,
              borderTopColor: colors.line,
            },
          ]}
        >
          <View style={styles.composerRow}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={setDraft}
              onKeyPress={onKeyPress}
              placeholder="Type a message…"
              placeholderTextColor={colors.muted}
              multiline
              // One row on web (textarea defaults to two); grows while typing.
              numberOfLines={1}
              maxLength={MAX_MESSAGE_LENGTH}
              autoFocus={Platform.OS === "web"}
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.panelAlt,
                  borderColor: colors.line,
                },
              ]}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              onPress={send}
              disabled={!draft.trim() || sending}
              style={[
                styles.send,
                { backgroundColor: colors.buttonBg },
                (!draft.trim() || sending) && styles.sendDisabled,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={colors.buttonText} />
              ) : (
                <Text style={[styles.sendIcon, { color: colors.buttonText }]}>
                  ↑
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  loader: {
    flex: 1,
  },

  list: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 16,
    gap: 8,
    flexGrow: 1,
  },

  empty: {
    textAlign: "center",
    fontSize: 15,
    marginVertical: 40,
  },

  row: {
    flexDirection: "row",
  },

  rowOwn: {
    justifyContent: "flex-end",
  },

  rowOther: {
    justifyContent: "flex-start",
  },

  bubble: {
    maxWidth: "80%",
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 6,
  },

  bubbleOwn: {
    borderBottomRightRadius: 4,
  },

  bubbleOther: {
    borderBottomLeftRadius: 4,
  },

  content: {
    fontSize: 16,
    lineHeight: 22,
  },

  time: {
    fontSize: 11,
    marginTop: 3,
    opacity: 0.7,
  },

  timeOwn: {
    textAlign: "right",
  },

  error: {
    textAlign: "center",
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },

  composer: {
    paddingHorizontal: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },

  composerRow: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },

  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 140,
    borderRadius: 23,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
  },

  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },

  sendDisabled: {
    opacity: 0.4,
  },

  sendIcon: {
    fontSize: 22,
    fontWeight: "700",
  },
});
