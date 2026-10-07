import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
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
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import IconButton from "@/components/icon-button";
import { noWebOutline } from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useChats } from "@/context/chats";
import { usePresence, useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { getMessages, sendMessage, type Message } from "@/lib/api";
import {
  formatDayLabel,
  formatPresence,
  formatTime,
  previewText,
} from "@/lib/format";
import { useIsWide } from "@/lib/layout";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { radius } from "@/theme/colors";

const MAX_MESSAGE_LENGTH = 4096;

// Messages of one sender closer than this are drawn as one group.
const GROUP_GAP_MS = 5 * 60 * 1000;

const INPUT_MIN_HEIGHT = 22;
const INPUT_MAX_HEIGHT = 140;

type Row =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string }
  | {
      type: "message";
      key: string;
      message: Message;
      own: boolean;
      // Joined to the previous / next bubble of the same group.
      joinedAbove: boolean;
      joinedBelow: boolean;
    };

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

const time = (iso: string) => new Date(iso).getTime();

// Day separators, the "unread" line and bubble groups, newest first (the
// list is inverted so it starts at the bottom).
function buildRows(
  messages: Message[],
  ownId: string | undefined,
  unreadAfter: string | null,
): Row[] {
  const rows: Row[] = [];
  let unreadShown = false;

  messages.forEach((message, i) => {
    const prev = messages[i - 1];
    const own = message.sender_id === ownId;
    let separated = false;

    const day = new Date(message.created_at).toDateString();

    if (!prev || new Date(prev.created_at).toDateString() !== day) {
      rows.push({
        type: "day",
        key: `day-${day}`,
        label: formatDayLabel(message.created_at),
      });
      separated = true;
    }

    if (
      unreadAfter &&
      !unreadShown &&
      !own &&
      time(message.created_at) > time(unreadAfter)
    ) {
      rows.push({ type: "unread", key: "unread" });
      unreadShown = true;
      separated = true;
    }

    const joinedAbove =
      !separated &&
      prev !== undefined &&
      prev.sender_id === message.sender_id &&
      time(message.created_at) - time(prev.created_at) < GROUP_GAP_MS;

    if (joinedAbove) {
      const above = rows[rows.length - 1];

      if (above.type === "message") {
        above.joinedBelow = true;
      }
    }

    rows.push({
      type: "message",
      key: message.id,
      message,
      own,
      joinedAbove,
      joinedBelow: false,
    });
  });

  return rows.reverse();
}

export default function ChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { status, subscribeChat } = useRealtime();
  const { chats, setActiveChat, markChatRead, setPeerReadAt } = useChats();
  useMinuteTick();

  const { chatId } = useLocalSearchParams<{ chatId: string }>();

  // Who the chat is with comes from the server's chats list, never from the
  // URL: anyone can craft a link with a misleading name.
  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const peerPresence = usePresence(chat?.user_id);

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [scrolledUp, setScrolledUp] = useState(false);
  // Where unread messages started when the chat was opened.
  const [unreadAfter, setUnreadAfter] = useState<string | null>(null);
  // The message the next one replies to.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Long-pressed message: its actions are shown.
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  // Briefly highlighted after jumping to it from a quote.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Row>>(null);
  const firstLoad = useRef(true);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  // A new chat: start from scratch.
  useEffect(() => {
    setMessages(null);
    setError(null);
    setUnreadAfter(null);
    setReplyTo(null);
    firstLoad.current = true;
  }, [chatId]);

  // Incoming messages of the chat on screen are read right away.
  useEffect(() => {
    setActiveChat(chatId);
    return () => setActiveChat(null);
  }, [chatId, setActiveChat]);

  const loadHistory = useCallback(async () => {
    try {
      const history = await withToken((t) => getMessages(t, chatId));
      setMessages((current) => mergeMessages(current ?? [], history.messages));
      setPeerReadAt(chatId, history.peer_last_read_at);
      setError(null);

      if (firstLoad.current) {
        firstLoad.current = false;
        setUnreadAfter(history.last_read_at);
      }

      const newest = history.messages[history.messages.length - 1];

      if (
        newest &&
        newest.sender_id !== user?.id &&
        (!history.last_read_at ||
          time(newest.created_at) > time(history.last_read_at))
      ) {
        markChatRead(chatId, newest);
      }
    } catch (e) {
      setMessages((current) => current ?? []);
      setError(e instanceof Error ? e.message : "Failed to load messages");
    }
  }, [chatId, withToken, setPeerReadAt, markChatRead, user?.id]);

  // Initial history, also when the realtime connection is down.
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Live updates. History is reloaded after every join, so nothing sent
  // while disconnected is missed.
  useEffect(
    () =>
      subscribeChat(chatId, {
        onJoined: loadHistory,
        onMessage: (message) =>
          setMessages((current) => mergeMessages(current ?? [], [message])),
      }),
    [chatId, subscribeChat, loadHistory],
  );

  const rows = useMemo(
    () => buildRows(messages ?? [], user?.id, unreadAfter),
    [messages, user?.id, unreadAfter],
  );

  const send = async () => {
    const content = draft.trim();

    if (!content || sending) {
      return;
    }

    setSending(true);
    // Clear right away so the user can type the next message meanwhile.
    setDraft("");
    setInputHeight(INPUT_MIN_HEIGHT);
    // Own messages end the "unread" section.
    setUnreadAfter(null);
    const replying = replyTo;
    setReplyTo(null);

    try {
      const message = await withToken((t) =>
        sendMessage(t, chatId, content, replying?.id ?? null),
      );
      setMessages((current) => mergeMessages(current ?? [], [message]));
      setError(null);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      // Give the unsent text back unless something new was typed.
      setDraft((current) => current || content);
      setReplyTo((current) => current ?? replying);
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const startReply = (message: Message) => {
    setMenuFor(null);
    setReplyTo(message);
    inputRef.current?.focus();
  };

  const copyText = async (message: Message) => {
    setMenuFor(null);
    await Clipboard.setStringAsync(message.content);
  };

  // Jumps to a quoted message (if it is loaded) and highlights it.
  const showMessage = (messageId: string) => {
    const index = rows.findIndex(
      (row) => row.type === "message" && row.message.id === messageId,
    );

    if (index < 0) {
      return;
    }

    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    setHighlightedId(messageId);
    setTimeout(
      () => setHighlightedId((current) => (current === messageId ? null : current)),
      1600,
    );
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

    if (Platform.OS === "web" && nativeEvent.key === "Escape" && replyTo) {
      event.preventDefault();
      setReplyTo(null);
    }
  };

  if (chats !== null && !chat) {
    return (
      <View style={styles.screen}>
        <AppHeader onBack={wide ? undefined : goBack} title="Chat" />
        <View style={styles.center}>
          <Text style={[styles.notFound, { color: colors.muted }]}>
            Chat not found.
          </Text>
          <Button
            title="Back to chats"
            variant="secondary"
            onPress={() => router.replace("/chats")}
          />
        </View>
      </View>
    );
  }

  // The peer's presence is only known while we are connected ourselves.
  const peerOnline = status === "online" && Boolean(peerPresence?.online);
  const statusText =
    status === "online"
      ? formatPresence(peerPresence)
      : status === "connecting"
        ? "connecting…"
        : "waiting for network…";

  const peerReadAt = chat?.peer_last_read_at ?? null;
  const canSend = Boolean(draft.trim()) && !sending;

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AppHeader
        onBack={wide ? undefined : goBack}
        left={
          chat ? (
            <Avatar
              name={chat.username}
              avatarId={chat.avatar_id}
              size={38}
              online={peerOnline}
            />
          ) : null
        }
        title={chat?.username ?? "…"}
        subtitle={
          peerOnline ? (
            <Text style={{ color: colors.online }}>online</Text>
          ) : (
            statusText
          )
        }
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {messages === null ? (
          <ActivityIndicator color={colors.muted} style={styles.screen} />
        ) : (
          <View style={styles.screen}>
            <FlatList
              ref={listRef}
              inverted
              data={rows}
              keyExtractor={(row) => row.key}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              onScroll={(event) =>
                setScrolledUp(event.nativeEvent.contentOffset.y > 400)
              }
              scrollEventThrottle={100}
              // Rows have different heights: get close first, then retry.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                setTimeout(
                  () =>
                    listRef.current?.scrollToIndex({
                      index: info.index,
                      animated: true,
                      viewPosition: 0.5,
                    }),
                  120,
                );
              }}
              // Inverted: the "header" is at the top, above the oldest.
              ListEmptyComponent={
                <View style={[styles.emptyWrap, styles.flipped]}>
                  <View style={[styles.emptyCard, { backgroundColor: colors.panel }]}>
                    <Ionicons name="hand-right-outline" size={28} color={colors.accent} />
                    <Text style={[styles.emptyTitle, { color: colors.text }]}>
                      No messages yet
                    </Text>
                    <Text style={[styles.emptyText, { color: colors.muted }]}>
                      Say hi to @{chat?.username ?? "…"}!
                    </Text>
                  </View>
                </View>
              }
              renderItem={({ item }) => {
                if (item.type === "day") {
                  return (
                    <View style={styles.separator}>
                      <Text
                        style={[
                          styles.dayLabel,
                          { color: colors.muted, backgroundColor: colors.panel },
                        ]}
                      >
                        {item.label}
                      </Text>
                    </View>
                  );
                }

                if (item.type === "unread") {
                  return (
                    <View style={styles.separator}>
                      <View style={[styles.unreadLine, { backgroundColor: colors.accent }]} />
                      <Text style={[styles.unreadLabel, { color: colors.accent }]}>
                        Unread messages
                      </Text>
                      <View style={[styles.unreadLine, { backgroundColor: colors.accent }]} />
                    </View>
                  );
                }

                return (
                  <Bubble
                    row={item}
                    read={
                      item.own &&
                      peerReadAt !== null &&
                      time(peerReadAt) >= time(item.message.created_at)
                    }
                    ownId={user?.id}
                    highlighted={item.message.id === highlightedId}
                    onReply={() => startReply(item.message)}
                    onMenu={() => setMenuFor(item.message)}
                    onQuotePress={showMessage}
                  />
                );
              }}
            />

            {scrolledUp ? (
              <IconButton
                icon="chevron-down"
                label="Scroll to the newest message"
                onPress={() =>
                  listRef.current?.scrollToOffset({ offset: 0, animated: true })
                }
                style={[
                  styles.scrollDown,
                  {
                    backgroundColor: colors.panel,
                    borderColor: colors.line,
                    boxShadow: `0 2px 8px ${colors.shadow}`,
                  },
                ]}
              />
            ) : null}
          </View>
        )}

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              paddingBottom: insets.bottom + 10,
              backgroundColor: colors.surface,
              borderTopColor: colors.line,
            },
          ]}
        >
          {replyTo ? (
            <View style={styles.replyBar}>
              <Ionicons name="arrow-undo" size={18} color={colors.accent} />
              <View style={[styles.replyBarText, { borderLeftColor: colors.accent }]}>
                <Text numberOfLines={1} style={[styles.replyBarName, { color: colors.accent }]}>
                  Reply to{" "}
                  {replyTo.sender_id === user?.id ? "yourself" : replyTo.sender_username}
                </Text>
                <Text numberOfLines={1} style={[styles.replyBarContent, { color: colors.muted }]}>
                  {previewText(replyTo.content)}
                </Text>
              </View>
              <IconButton
                icon="close"
                label="Cancel reply"
                size={18}
                color={colors.muted}
                onPress={() => setReplyTo(null)}
              />
            </View>
          ) : null}

          <View style={styles.composerRow}>
            <View style={[styles.inputBox, { backgroundColor: colors.panelAlt }]}>
              <TextInput
                ref={inputRef}
                value={draft}
                onChangeText={setDraft}
                onKeyPress={onKeyPress}
                placeholder="Message"
                placeholderTextColor={colors.muted}
                multiline
                // One row on web (textarea defaults to two); grows while typing.
                numberOfLines={1}
                maxLength={MAX_MESSAGE_LENGTH}
                autoFocus={Platform.OS === "web"}
                onContentSizeChange={(event) =>
                  setInputHeight(
                    Math.min(
                      INPUT_MAX_HEIGHT,
                      Math.max(
                        INPUT_MIN_HEIGHT,
                        event.nativeEvent.contentSize.height,
                      ),
                    ),
                  )
                }
                style={[
                  styles.input,
                  { color: colors.text, height: inputHeight },
                  noWebOutline,
                ]}
              />
            </View>

            <IconButton
              icon="arrow-up"
              label="Send"
              filled
              size={22}
              onPress={send}
              disabled={!canSend}
            />
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* A plain overlay rather than a Modal: on web a Modal hands the focus
          back to the message when it closes, away from the input. */}
      {menuFor ? (
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setMenuFor(null)}
          accessibilityLabel="Close menu"
        >
          {menuFor ? (
            <View style={[styles.menu, { backgroundColor: colors.panel }]}>
              <Text numberOfLines={2} style={[styles.menuPreview, { color: colors.muted }]}>
                {previewText(menuFor.content)}
              </Text>
              <MenuItem icon="arrow-undo-outline" label="Reply" onPress={() => startReply(menuFor)} />
              <MenuItem icon="copy-outline" label="Copy text" onPress={() => copyText(menuFor)} />
            </View>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
}: {
  icon: "arrow-undo-outline" | "copy-outline";
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ hovered, pressed }) => [
        styles.menuItem,
        (hovered || pressed) && { backgroundColor: colors.hover },
      ]}
    >
      <Ionicons name={icon} size={20} color={colors.text} />
      <Text style={[styles.menuLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

function Bubble({
  row,
  read,
  ownId,
  highlighted,
  onReply,
  onMenu,
  onQuotePress,
}: {
  row: Extract<Row, { type: "message" }>;
  read: boolean;
  ownId: string | undefined;
  highlighted: boolean;
  onReply: () => void;
  // Long press: the message's actions (reply, copy).
  onMenu: () => void;
  onQuotePress: (messageId: string) => void;
}) {
  const { colors } = useAppTheme();
  const [hovered, setHovered] = useState(false);
  const { message, own, joinedAbove, joinedBelow } = row;
  const quote = message.reply_to;

  // The corners next to the bubble's neighbours in its group are smaller.
  const side = own ? "Right" : "Left";
  const corners = {
    [`borderTop${side}Radius`]: joinedAbove ? radius.bubbleJoined : radius.bubble,
    [`borderBottom${side}Radius`]: joinedBelow ? radius.bubbleJoined : radius.bubble,
  };

  const textColor = own ? colors.onAccent : colors.text;
  const metaColor = own ? colors.onAccent : colors.muted;

  // Web: a reply button next to the hovered bubble.
  const replyButton =
    Platform.OS === "web" && hovered ? (
      <IconButton
        icon="arrow-undo-outline"
        label="Reply"
        size={18}
        color={colors.muted}
        onPress={onReply}
        style={styles.hoverReply}
      />
    ) : null;

  return (
    <Pressable
      onLongPress={onMenu}
      delayLongPress={350}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      // The whole row, so the hover button does not flicker away.
      style={[
        styles.row,
        own ? styles.rowOwn : styles.rowOther,
        { marginTop: joinedAbove ? 2 : 10 },
        highlighted && { backgroundColor: colors.accentSoft },
        styles.rowHighlightable,
      ]}
    >
      {own ? replyButton : null}

      <View
        style={[
          styles.bubble,
          corners,
          { backgroundColor: own ? colors.accent : colors.panel },
        ]}
      >
        {quote ? (
          <Pressable
            onPress={() => onQuotePress(quote.id)}
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${quote.sender_username}: ${quote.content}`}
            style={[
              styles.quote,
              {
                borderLeftColor: own ? colors.onAccent : colors.accent,
                backgroundColor: own ? "rgba(0, 0, 0, 0.12)" : colors.accentSoft,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.quoteName, { color: own ? colors.onAccent : colors.accent }]}
            >
              {quote.sender_id === ownId ? "You" : quote.sender_username}
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.quoteText, { color: own ? colors.onAccent : colors.textSoft }]}
            >
              {previewText(quote.content)}
            </Text>
          </Pressable>
        ) : null}

        <Text
          // Phones copy through the long-press menu; selecting text there
          // would take over the long press.
          selectable={Platform.OS === "web"}
          style={[styles.content, { color: textColor }]}
        >
          {message.content}
        </Text>
        <View style={styles.bubbleMeta}>
          <Text style={[styles.time, { color: metaColor }]}>
            {formatTime(message.created_at)}
          </Text>
          {own ? (
            <Ionicons
              name={read ? "checkmark-done" : "checkmark"}
              size={14}
              color={metaColor}
              accessibilityLabel={read ? "read" : "sent"}
            />
          ) : null}
        </View>
      </View>

      {own ? null : replyButton}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },

  notFound: {
    fontSize: 16,
  },

  list: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexGrow: 1,
  },

  // The empty component of an inverted list is drawn upside down.
  flipped: {
    transform: [{ scaleY: -1 }],
  },

  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },

  emptyCard: {
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 28,
    paddingVertical: 22,
    borderRadius: radius.card,
  },

  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
  },

  emptyText: {
    fontSize: 14,
  },

  separator: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 14,
    marginBottom: 4,
  },

  dayLabel: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: "hidden",
  },

  unreadLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth * 2,
    opacity: 0.5,
  },

  unreadLabel: {
    fontSize: 12,
    fontWeight: "700",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },

  rowHighlightable: {
    borderRadius: radius.bubble,
  },

  hoverReply: {
    opacity: 0.9,
  },

  quote: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 5,
    marginTop: 2,
  },

  quoteName: {
    fontSize: 13,
    fontWeight: "700",
  },

  quoteText: {
    fontSize: 13,
    lineHeight: 18,
    opacity: 0.9,
  },

  replyBar: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 6,
    paddingBottom: 8,
  },

  replyBarText: {
    flex: 1,
    borderLeftWidth: 2,
    paddingLeft: 8,
  },

  replyBarName: {
    fontSize: 13,
    fontWeight: "700",
  },

  replyBarContent: {
    fontSize: 13,
  },

  menuBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

  menu: {
    width: "100%",
    maxWidth: 320,
    borderRadius: radius.card,
    paddingVertical: 6,
    overflow: "hidden",
  },

  menuPreview: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },

  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 48,
    paddingHorizontal: 16,
  },

  menuLabel: {
    fontSize: 16,
  },

  rowOwn: {
    justifyContent: "flex-end",
    paddingLeft: 48,
  },

  rowOther: {
    justifyContent: "flex-start",
    paddingRight: 48,
  },

  bubble: {
    // Wrap long text inside the row instead of overflowing it.
    flexShrink: 1,
    maxWidth: 560,
    borderRadius: radius.bubble,
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 5,
  },

  content: {
    fontSize: 16,
    lineHeight: 22,
  },

  bubbleMeta: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 3,
    marginTop: 1,
  },

  time: {
    fontSize: 11,
    opacity: 0.75,
  },

  scrollDown: {
    position: "absolute",
    right: 16,
    bottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },

  error: {
    textAlign: "center",
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },

  composer: {
    paddingHorizontal: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },

  composerRow: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },

  inputBox: {
    flex: 1,
    minHeight: 42,
    borderRadius: 21,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: "center",
  },

  input: {
    fontSize: 16,
    lineHeight: 22,
    padding: 0,
    // Android adds its own vertical padding to multiline inputs.
    textAlignVertical: "center",
  },
});
