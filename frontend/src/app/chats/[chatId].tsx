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
import ActionMenu from "@/components/action-menu";
import AppHeader from "@/components/app-header";
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import DevBadge from "@/components/dev-badge";
import IconButton from "@/components/icon-button";
import MessageBubble from "@/components/message-bubble";
import SafetyCode from "@/components/safety-code";
import { noWebOutline } from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useChats } from "@/context/chats";
import { usePresence, useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import {
  deleteMessage,
  editMessage,
  getMessages,
  REACTIONS,
  type ChatHistory,
  sendMessage,
  setBlocked,
  setReaction,
  type Message,
  type Reaction,
} from "@/lib/api";
import {
  buildRows,
  mergeMessages,
  reconcileHistory,
  time,
  type Row,
} from "@/lib/chat-rows";
import { newMessageId, type Decrypted, type MessageRef } from "@/lib/crypto";
import { formatPresence, previewText } from "@/lib/format";
import { acceptPeerKey, checkPeerKey } from "@/lib/known-keys";
import { useIsWide } from "@/lib/layout";
import { useChatCrypto } from "@/lib/use-chat-crypto";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { radius } from "@/theme/colors";

const MAX_MESSAGE_LENGTH = 4096;

const INPUT_MIN_HEIGHT = 22;
const INPUT_MAX_HEIGHT = 140;

// A new screen instance for every chat: nothing of the previous chat
// (history, draft, requests still in flight) can end up in the next one.
export default function ChatRoute() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();

  return <ChatScreen key={chatId} chatId={chatId} />;
}

function ChatScreen({ chatId }: { chatId: string }) {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { status, subscribeChat, subscribeEvents, sendTyping } = useRealtime();
  const {
    chats,
    setActiveChat,
    markChatRead,
    setPeerReadAt,
    typing,
    updateChatSettings,
    removeChat,
    reload: reloadChats,
  } = useChats();
  useMinuteTick();

  // Who the chat is with comes from the server's chats list, never from the
  // URL: anyone can craft a link with a misleading name.
  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const peerPresence = usePresence(chat?.user_id);
  const crypto = useChatCrypto(chat);

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
  // Older history (loaded while scrolling up).
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The own message being edited in the composer.
  const [editing, setEditing] = useState<Message | null>(null);
  // The chat's menu (search, safety code, pin, mute, block, delete).
  const [chatMenu, setChatMenu] = useState(false);
  const [showSafetyCode, setShowSafetyCode] = useState(false);
  // The other member's key differs from the one this device saw before.
  const [keyChanged, setKeyChanged] = useState(false);
  // Search in the loaded messages.
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const lastTypingSent = useRef(0);

  const inputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<Row>>(null);
  const firstLoad = useRef(true);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  // Incoming messages of the chat on screen are read right away.
  useEffect(() => {
    setActiveChat(chatId);
    return () => setActiveChat(null);
  }, [chatId, setActiveChat]);

  // Compare the other member's key with the one seen before on this device.
  const ownId = user?.id;
  const peerId = chat?.user_id;
  const peerKey = chat?.public_key;

  useEffect(() => {
    if (!ownId || !peerId || !peerKey) {
      return;
    }

    let current = true;

    checkPeerKey(ownId, peerId, peerKey)
      .then((state) => current && setKeyChanged(state === "changed"))
      .catch(() => {});

    return () => {
      current = false;
    };
  }, [ownId, peerId, peerKey]);

  const confirmPeerKey = async () => {
    if (ownId && peerId && peerKey) {
      await acceptPeerKey(ownId, peerId, peerKey);
    }

    setKeyChanged(false);
    setShowSafetyCode(false);
  };

  // The newest history; after a reconnect it also drops what was deleted
  // meanwhile.
  const applyHistory = useCallback(
    (history: ChatHistory) => {
      setMessages((current) =>
        reconcileHistory(current ?? [], history.messages, !history.has_more),
      );
      setPeerReadAt(chatId, history.peer_last_read_at);
      setError(null);

      if (firstLoad.current) {
        firstLoad.current = false;
        setUnreadAfter(history.last_read_at);
        setHasMore(history.has_more);
      }

      const newest = history.messages[history.messages.length - 1];

      if (
        newest &&
        newest.sender_id !== ownId &&
        (!history.last_read_at ||
          time(newest.created_at) > time(history.last_read_at))
      ) {
        markChatRead(chatId, newest);
      }
    },
    [chatId, setPeerReadAt, markChatRead, ownId],
  );

  const loadHistory = useCallback(
    () =>
      withToken((t) => getMessages(t, chatId)).then(applyHistory, (e) => {
        setMessages((current) => current ?? []);
        setError(e instanceof Error ? e.message : "Failed to load messages");
      }),
    [chatId, withToken, applyHistory],
  );

  // Older messages, when scrolled to the top of what is loaded.
  const loadOlder = useCallback(async () => {
    const oldest = messages?.[0];

    if (!hasMore || loadingOlder || !oldest) {
      return;
    }

    setLoadingOlder(true);

    try {
      const history = await withToken((t) => getMessages(t, chatId, oldest.id));
      setMessages((current) => mergeMessages(current ?? [], history.messages));
      setHasMore(history.has_more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load messages");
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, hasMore, loadingOlder, withToken, chatId]);

  // Edits, deletions and reactions from any device; the chat being deleted.
  useEffect(
    () =>
      subscribeEvents({
        onEvent: (event) => {
          if (event.type === "message_updated" && event.message.chat_id === chatId) {
            setMessages((current) =>
              current?.map((m) => (m.id === event.message.id ? event.message : m)) ??
              current,
            );
          } else if (event.type === "message_deleted" && event.chatId === chatId) {
            setMessages((current) => current?.filter((m) => m.id !== event.messageId) ?? current);
          } else if (event.type === "reactions" && event.chatId === chatId) {
            setMessages((current) =>
              current?.map((m) =>
                m.id === event.messageId ? { ...m, reactions: event.reactions } : m,
              ) ?? current,
            );
          } else if (event.type === "chat_deleted" && event.chatId === chatId) {
            router.replace("/chats");
          }
        },
      }),
    [subscribeEvents, chatId, router],
  );

  // Initial history, also when the realtime connection is down. History
  // is reloaded after every join as well, so nothing sent while
  // disconnected is missed.
  useEffect(() => {
    loadHistory();

    return subscribeChat(chatId, {
      onJoined: loadHistory,
      onMessage: (message) =>
        setMessages((current) => mergeMessages(current ?? [], [message])),
    });
  }, [chatId, subscribeChat, loadHistory]);

  // Decrypted once per message.
  const texts = useMemo(
    () => new Map((messages ?? []).map((m) => [m.id, crypto.decrypt(m)])),
    [messages, crypto],
  );
  const textOf = (message: MessageRef & { content: string }): Decrypted =>
    texts.get(message.id) ?? crypto.decrypt(message);

  const rows = useMemo(
    () => buildRows(messages ?? [], user?.id, unreadAfter),
    [messages, user?.id, unreadAfter],
  );

  // Search: matching messages, newest first.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!searching || !needle) {
      return [];
    }

    return (messages ?? [])
      .filter((m) => (texts.get(m.id)?.text ?? "").toLowerCase().includes(needle))
      .map((m) => m.id)
      .reverse();
  }, [searching, query, messages, texts]);

  const showError = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  const send = async () => {
    const content = draft.trim();

    if (!content || sending || keyChanged) {
      return;
    }

    if (editing) {
      const target = editing;
      setSending(true);
      setDraft("");
      setEditing(null);
      setInputHeight(INPUT_MIN_HEIGHT);

      try {
        const updated = await withToken((t) =>
          editMessage(t, chatId, target.id, crypto.encrypt(content, target.id)),
        );
        setMessages((current) =>
          current?.map((m) => (m.id === updated.id ? updated : m)) ?? current,
        );
        setError(null);
      } catch (e) {
        setDraft((current) => current || content);
        setEditing((current) => current ?? target);
        showError(e, "Failed to edit the message");
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }

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
      const id = newMessageId();
      const encrypted = crypto.encrypt(content, id);
      const message = await withToken((t) =>
        sendMessage(t, chatId, {
          id,
          content: encrypted,
          replyTo: replying?.id ?? null,
        }),
      );
      setMessages((current) => mergeMessages(current ?? [], [message]));
      setError(null);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      // Give the unsent text back unless something new was typed.
      setDraft((current) => current || content);
      setReplyTo((current) => current ?? replying);
      showError(e, "Failed to send message");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const startReply = (message: Message) => {
    setMenuFor(null);
    setEditing(null);
    setReplyTo(message);
    inputRef.current?.focus();
  };

  const startEdit = (message: Message) => {
    setMenuFor(null);
    setReplyTo(null);
    setEditing(message);
    setDraft(textOf(message).text);
    inputRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft("");
  };

  const removeMessage = async (message: Message) => {
    setMenuFor(null);

    try {
      await withToken((t) => deleteMessage(t, chatId, message.id));
      setMessages((current) => current?.filter((m) => m.id !== message.id) ?? current);
    } catch (e) {
      showError(e, "Failed to delete the message");
    }
  };

  // Tapping your own reaction removes it; another emoji replaces it.
  const react = async (message: Message, emoji: string) => {
    setMenuFor(null);

    const mine = message.reactions.find((r) => r.user_id === user?.id);
    const next = mine?.emoji === emoji ? null : emoji;
    const optimistic: Reaction[] = [
      ...message.reactions.filter((r) => r.user_id !== user?.id),
      ...(next && user ? [{ emoji: next, user_id: user.id }] : []),
    ];

    const setReactions = (reactions: Reaction[]) =>
      setMessages((current) =>
        current?.map((m) => (m.id === message.id ? { ...m, reactions } : m)) ?? current,
      );

    setReactions(optimistic);

    try {
      setReactions(await withToken((t) => setReaction(t, chatId, message.id, next)));
    } catch (e) {
      setReactions(message.reactions);
      showError(e, "Failed to react");
    }
  };

  const onDraftChange = (text: string) => {
    setDraft(text);

    // "typing…" for the other member, at most every few seconds.
    if (text.trim() && !editing && Date.now() - lastTypingSent.current > 3000) {
      lastTypingSent.current = Date.now();
      sendTyping(chatId);
    }
  };

  const toggleBlocked = async () => {
    if (!chat) {
      return;
    }

    setChatMenu(false);

    try {
      await withToken((t) => setBlocked(t, chat.user_id, !chat.blocked_by_me));
      await reloadChats();
    } catch (e) {
      showError(e, "Something went wrong");
    }
  };

  const changeSettings = async (settings: { pinned?: boolean; muted?: boolean }) => {
    setChatMenu(false);

    try {
      await updateChatSettings(chatId, settings);
    } catch (e) {
      showError(e, "Failed to change the chat");
    }
  };

  const deleteChat = async (scope: "everyone" | "me") => {
    setChatMenu(false);

    try {
      await removeChat(chatId, scope);
      router.replace("/chats");
    } catch (e) {
      showError(e, "Failed to delete the chat");
    }
  };

  const openSearch = () => {
    setChatMenu(false);
    setSearching(true);
    setQuery("");
    setMatchIndex(0);
  };

  // Jumps to the n-th match (0 = newest).
  const goToMatch = (index: number) => {
    if (matches.length === 0) {
      return;
    }

    const next = Math.max(0, Math.min(matches.length - 1, index));
    setMatchIndex(next);
    showMessage(matches[next]);
  };

  const copyText = async (message: Message) => {
    setMenuFor(null);
    await Clipboard.setStringAsync(textOf(message).text);
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

    if (Platform.OS === "web" && nativeEvent.key === "Escape" && (replyTo || editing)) {
      event.preventDefault();
      setReplyTo(null);

      if (editing) {
        cancelEdit();
      }
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
  const canSend = Boolean(draft.trim()) && !sending && !keyChanged;

  // Why the composer is replaced, if it is.
  const composerBlocked = chat?.blocked_by_me
    ? "byMe"
    : chat?.blocked
      ? "byThem"
      : null;

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
        titleBadge={chat?.is_developer ? <DevBadge size="md" /> : null}
        subtitle={
          typing.has(chatId) ? (
            <Text style={{ color: colors.accent }}>typing…</Text>
          ) : peerOnline ? (
            <Text style={{ color: colors.online }}>online</Text>
          ) : (
            statusText
          )
        }
        right={
          chat ? (
            <>
              <IconButton icon="search" label="Search in chat" size={20} onPress={openSearch} />
              <IconButton
                icon="ellipsis-vertical"
                label="Chat menu"
                size={20}
                onPress={() => setChatMenu(true)}
              />
            </>
          ) : null
        }
      />

      {searching ? (
        <View style={[styles.searchBar, { backgroundColor: colors.surface, borderBottomColor: colors.line }]}>
          <View style={styles.searchRow}>
            <View style={[styles.searchBox, { backgroundColor: colors.panelAlt }]}>
              <Ionicons name="search" size={16} color={colors.muted} />
              <TextInput
                value={query}
                onChangeText={(text) => {
                  setQuery(text);
                  setMatchIndex(0);
                }}
                onSubmitEditing={() => goToMatch(matchIndex)}
                placeholder="Search messages"
                placeholderTextColor={colors.muted}
                autoFocus
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.text }, noWebOutline]}
              />
            </View>
            <Text style={[styles.searchCount, { color: colors.muted }]}>
              {query.trim() ? (matches.length ? `${matchIndex + 1}/${matches.length}` : "0") : ""}
            </Text>
            <IconButton
              icon="chevron-up"
              label="Older match"
              size={18}
              disabled={matchIndex >= matches.length - 1}
              onPress={() => goToMatch(matchIndex + 1)}
            />
            <IconButton
              icon="chevron-down"
              label="Newer match"
              size={18}
              disabled={matchIndex <= 0}
              onPress={() => goToMatch(matchIndex - 1)}
            />
            <IconButton
              icon="close"
              label="Close search"
              size={18}
              onPress={() => setSearching(false)}
            />
          </View>
          {hasMore ? (
            // Messages are decrypted on this device, so only loaded ones
            // can be searched.
            <Pressable
              onPress={loadOlder}
              disabled={loadingOlder}
              accessibilityRole="button"
              style={styles.searchOlder}
            >
              <Text style={[styles.searchOlderText, { color: colors.muted }]}>
                Searching loaded messages.{" "}
                <Text style={{ color: colors.accent }}>
                  {loadingOlder ? "Loading…" : "Load older"}
                </Text>
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

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
              // Inverted: the end is the top, the oldest loaded message.
              onEndReached={loadOlder}
              onEndReachedThreshold={0.4}
              ListFooterComponent={
                loadingOlder ? (
                  <ActivityIndicator color={colors.muted} style={styles.older} />
                ) : null
              }
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
                  <MessageBubble
                    row={item}
                    read={
                      item.own &&
                      peerReadAt !== null &&
                      time(peerReadAt) >= time(item.message.created_at)
                    }
                    ownId={user?.id}
                    text={textOf(item.message)}
                    quoteText={
                      item.message.reply_to ? textOf(item.message.reply_to) : null
                    }
                    highlighted={item.message.id === highlightedId}
                    onReply={() => startReply(item.message)}
                    onMenu={() => setMenuFor(item.message)}
                    onQuotePress={showMessage}
                    onReact={(emoji) => react(item.message, emoji)}
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

        {chat && !crypto.canEncrypt && !composerBlocked ? (
          <Text style={[styles.notice, { color: colors.muted }]}>
            @{chat.username} has not set up end-to-end encryption yet. You can
            write once they open the updated Ostrich.
          </Text>
        ) : null}

        {chat && keyChanged ? (
          <Pressable
            onPress={() => setShowSafetyCode(true)}
            accessibilityRole="button"
            style={[styles.keyWarning, { backgroundColor: colors.panel }]}
          >
            <Ionicons name="warning-outline" size={18} color={colors.danger} />
            <Text style={[styles.keyWarningText, { color: colors.text }]}>
              The security key of @{chat.username} has changed.{" "}
              <Text style={{ color: colors.accent }}>Compare the safety code</Text>
            </Text>
          </Pressable>
        ) : null}

        {error ? (
          <Pressable
            onPress={() => setError(null)}
            accessibilityRole="button"
            accessibilityHint="Dismisses the error"
            style={styles.errorRow}
          >
            <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
            <Ionicons name="close" size={16} color={colors.danger} />
          </Pressable>
        ) : null}

        {chat && composerBlocked ? (
          <View
            style={[
              styles.composer,
              styles.blockedBar,
              {
                paddingBottom: insets.bottom + 10,
                backgroundColor: colors.surface,
                borderTopColor: colors.line,
              },
            ]}
          >
            <Text style={[styles.blockedText, { color: colors.muted }]}>
              {composerBlocked === "byMe"
                ? `You blocked @${chat.username}`
                : `You can't message @${chat.username}`}
            </Text>
            {composerBlocked === "byMe" ? (
              <Button title="Unblock" variant="secondary" onPress={toggleBlocked} />
            ) : null}
          </View>
        ) : (
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
            {editing ? (
              <View style={styles.replyBar}>
                <Ionicons name="create-outline" size={18} color={colors.accent} />
                <View style={[styles.replyBarText, { borderLeftColor: colors.accent }]}>
                  <Text style={[styles.replyBarName, { color: colors.accent }]}>
                    Edit message
                  </Text>
                  <Text numberOfLines={1} style={[styles.replyBarContent, { color: colors.muted }]}>
                    {previewText(textOf(editing).text)}
                  </Text>
                </View>
                <IconButton
                  icon="close"
                  label="Cancel editing"
                  size={18}
                  color={colors.muted}
                  onPress={cancelEdit}
                />
              </View>
            ) : null}

            {replyTo ? (
              <View style={styles.replyBar}>
                <Ionicons name="arrow-undo" size={18} color={colors.accent} />
                <View style={[styles.replyBarText, { borderLeftColor: colors.accent }]}>
                  <View style={styles.replyBarNameRow}>
                    <Text numberOfLines={1} style={[styles.replyBarName, { color: colors.accent }]}>
                      Reply to{" "}
                      {replyTo.sender_id === user?.id ? "yourself" : replyTo.sender_username}
                    </Text>
                    {(replyTo.sender_id === user?.id
                      ? user?.is_developer
                      : chat?.is_developer) ? <DevBadge /> : null}
                  </View>
                  <Text numberOfLines={1} style={[styles.replyBarContent, { color: colors.muted }]}>
                    {previewText(textOf(replyTo).text)}
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
                  onChangeText={onDraftChange}
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
                icon={editing ? "checkmark" : "arrow-up"}
                label={editing ? "Save" : "Send"}
                filled
                size={22}
                onPress={send}
                disabled={!canSend}
              />
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Plain overlays rather than Modals: on web a Modal hands the focus
          back to the message when it closes, away from the input. */}
      {menuFor ? (
        <ActionMenu
          title={previewText(textOf(menuFor).text)}
          onClose={() => setMenuFor(null)}
          header={
            <View style={styles.reactionPicker}>
              {REACTIONS.map((emoji) => {
                const mine = menuFor.reactions.some(
                  (r) => r.user_id === user?.id && r.emoji === emoji,
                );

                return (
                  <Pressable
                    key={emoji}
                    onPress={() => react(menuFor, emoji)}
                    accessibilityRole="button"
                    accessibilityLabel={`React ${emoji}`}
                    style={({ hovered, pressed }) => [
                      styles.reactionOption,
                      (mine || hovered || pressed) && { backgroundColor: colors.accentSoft },
                    ]}
                  >
                    <Text style={styles.reactionOptionText}>{emoji}</Text>
                  </Pressable>
                );
              })}
            </View>
          }
          items={[
            { icon: "arrow-undo-outline", label: "Reply", onPress: () => startReply(menuFor) },
            { icon: "copy-outline", label: "Copy text", onPress: () => copyText(menuFor) },
            ...(menuFor.sender_id === user?.id
              ? [
                  { icon: "create-outline" as const, label: "Edit", onPress: () => startEdit(menuFor) },
                  {
                    icon: "trash-outline" as const,
                    label: "Delete",
                    confirmLabel: "Delete for everyone?",
                    danger: true,
                    onPress: () => removeMessage(menuFor),
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      {chatMenu && chat ? (
        <ActionMenu
          title={`@${chat.username}`}
          onClose={() => setChatMenu(false)}
          items={[
            { icon: "search", label: "Search in chat", onPress: openSearch },
            ...(crypto.safetyCode
              ? [
                  {
                    icon: "shield-checkmark-outline" as const,
                    label: "Safety code",
                    onPress: () => {
                      setChatMenu(false);
                      setShowSafetyCode(true);
                    },
                  },
                ]
              : []),
            {
              icon: chat.pinned ? "pin" : "pin-outline",
              label: chat.pinned ? "Unpin" : "Pin to top",
              onPress: () => changeSettings({ pinned: !chat.pinned }),
            },
            {
              icon: chat.muted ? "notifications-outline" : "notifications-off-outline",
              label: chat.muted ? "Unmute" : "Mute",
              onPress: () => changeSettings({ muted: !chat.muted }),
            },
            {
              icon: "ban-outline",
              label: chat.blocked_by_me ? `Unblock @${chat.username}` : `Block @${chat.username}`,
              ...(chat.blocked_by_me ? {} : { confirmLabel: "Block? They won't be able to message you" }),
              danger: !chat.blocked_by_me,
              onPress: toggleBlocked,
            },
            {
              icon: "eye-off-outline",
              label: "Clear history for me",
              confirmLabel: "Clear? @" + chat.username + " keeps the messages",
              danger: true,
              onPress: () => deleteChat("me"),
            },
            {
              icon: "trash-outline",
              label: "Delete for both",
              confirmLabel: "Delete the chat for both of you?",
              danger: true,
              onPress: () => deleteChat("everyone"),
            },
          ]}
        />
      ) : null}

      {showSafetyCode && chat && crypto.safetyCode ? (
        <SafetyCode
          username={chat.username}
          code={crypto.safetyCode}
          keyChanged={keyChanged}
          onConfirm={confirmPeerKey}
          onClose={() => setShowSafetyCode(false)}
        />
      ) : null}
    </View>
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

  searchBar: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },

  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    borderRadius: radius.input,
    paddingHorizontal: 12,
    marginRight: 6,
  },

  searchInput: {
    flex: 1,
    height: "100%",
    fontSize: 15,
  },

  searchCount: {
    minWidth: 36,
    textAlign: "center",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },

  searchOlder: {
    paddingHorizontal: 4,
  },

  searchOlderText: {
    fontSize: 13,
  },

  older: {
    paddingVertical: 14,
  },

  blockedBar: {
    alignItems: "center",
    gap: 10,
  },

  blockedText: {
    fontSize: 14,
  },

  reactionPicker: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },

  reactionOption: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },

  reactionOptionText: {
    fontSize: 22,
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

  replyBarNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },

  replyBarName: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
  },

  replyBarContent: {
    fontSize: 13,
  },

  scrollDown: {
    position: "absolute",
    right: 16,
    bottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },

  notice: {
    textAlign: "center",
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },

  keyWarning: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.card,
  },

  keyWarningText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },

  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },

  errorText: {
    flexShrink: 1,
    textAlign: "center",
    fontSize: 13,
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
