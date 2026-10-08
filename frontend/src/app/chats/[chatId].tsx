import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
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
import ActionMenu, { type ActionMenuItem } from "@/components/action-menu";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import Avatar from "@/components/avatar";
import ChatAvatar from "@/components/chat-avatar";
import DevBadge from "@/components/dev-badge";
import ForwardPicker from "@/components/forward-picker";
import GroupInfo from "@/components/group-info";
import IconButton from "@/components/icon-button";
import MessageBubble from "@/components/message-bubble";
import SafetyCode from "@/components/safety-code";
import { noWebOutline } from "@/components/text-field";
import { useAuth, useCurrentUser, usePrivateKey } from "@/context/auth";
import { useChats } from "@/context/chats";
import { outgoingAsMessage, useOutbox, type Outgoing } from "@/context/outbox";
import { usePresence, useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import {
  deleteMessage,
  editMessage,
  getGroupMembers,
  getMessages,
  type GroupMember,
  REACTIONS,
  type Chat,
  type ChatHistory,
  setBlocked,
  setReaction,
  type Message,
  type Reaction,
  type ReplyPreview,
} from "@/lib/api";
import {
  buildRows,
  mergeMessages,
  reconcileHistory,
  time,
  type Row,
} from "@/lib/chat-rows";
import { newMessageId, type MessageRef } from "@/lib/crypto";
import {
  copyAttachments,
  formatSize,
  isImage,
  loadAttachment,
  MAX_ATTACHMENTS,
  uploadAttachment,
  type PickedFile,
} from "@/lib/attachments";
import { saveFile } from "@/lib/files";
import { formatPresence, previewText } from "@/lib/format";
import { chatTitle, isGroupDistrusted } from "@/lib/groups";
import { loadCachedMessages, saveCachedMessages } from "@/lib/local-cache";
import { mentionedUsernames, plainText } from "@/lib/markup";
import { encodePayload, type Attachment } from "@/lib/payload";
import { pickDocument, pickPhoto } from "@/lib/pick-attachment";
import { messagePreview } from "@/lib/preview";
import { acceptPeerKey, checkPeerKey } from "@/lib/known-keys";
import { useIsWide } from "@/lib/layout";
import { encryptForChat, useChatCrypto, type Shown } from "@/lib/use-chat-crypto";
import { useStartChat } from "@/lib/use-start-chat";
import { useMinuteTick } from "@/lib/use-minute-tick";
import { radius } from "@/theme/colors";

const MAX_MESSAGE_LENGTH = 4096;

const INPUT_MIN_HEIGHT = 22;

// Whether "typing…" may be sent again (every few seconds at most); marks
// it sent.
function typingDue(lastSent: { current: number }) {
  const now = Date.now();

  if (now - lastSent.current < 3000) {
    return false;
  }

  lastSent.current = now;
  return true;
}
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
  const { status, presence, subscribeChat, subscribeEvents, sendTyping } = useRealtime();
  const {
    chats,
    synced,
    setActiveChat,
    markChatRead,
    setPeerReadAt,
    typing,
    typingUsers,
    updateChatSettings,
    removeChat,
    leaveGroup,
    reload: reloadChats,
    drafts,
    setDraft: storeDraft,
    pinMessage,
  } = useChats();
  const outbox = useOutbox();
  const privateKey = usePrivateKey();
  useMinuteTick();

  // Who the chat is with comes from the server's chats list, never from the
  // URL: anyone can craft a link with a misleading name.
  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const group = chat?.type === "group";
  const saved = chat?.type === "saved";
  // Groups: admins pin and delete others' messages.
  const groupAdmin = group && (chat?.role === "owner" || chat?.role === "admin");
  const peerPresence = usePresence(chat?.user_id ?? undefined);
  const crypto = useChatCrypto(chat);
  const startChat = useStartChat();

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unsent text, kept per chat on this device.
  const [draft, setDraft] = useState(() => drafts[chatId] ?? "");
  const [sending, setSending] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  // Where the cursor is in the draft (for @mention suggestions).
  const [cursor, setCursor] = useState<number | null>(null);
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
  // Groups: the members (for names, presence and the group's screen).
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  // The message being forwarded (choosing the chat).
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // Files chosen for the next message, and the menu to choose them.
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [attachMenu, setAttachMenu] = useState(false);
  // Uploading the chosen files.
  const [uploading, setUploading] = useState(false);
  // The other member's key differs from the one this device saw before.
  const [keyChanged, setKeyChanged] = useState(false);
  // Search in the loaded messages.
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const lastTypingSent = useRef(0);

  const inputRef = useRef<TextInput>(null);
  // Focusing the input is asked for here and done after the render.
  const [focusRequest, setFocusRequest] = useState(0);
  const requestFocus = () => setFocusRequest((n) => n + 1);

  useEffect(() => {
    if (focusRequest > 0) {
      inputRef.current?.focus();
    }
  }, [focusRequest]);
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

  // A group's members, again whenever the group changes.
  const memberCount = chat?.member_count;
  const groupUpdated = group ? chat?.updated_at : undefined;

  const loadMembers = useCallback(() => {
    withToken((t) => getGroupMembers(t, chatId)).then(setMembers, () => {});
  }, [withToken, chatId]);

  useEffect(() => {
    if (group) {
      loadMembers();
    }
  }, [group, memberCount, groupUpdated, loadMembers]);

  const memberNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.id, m.username])),
    [members],
  );

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

  // The history saved on the device shows until the server answers (and
  // when offline); what the server sends is saved again.
  useEffect(() => {
    if (!ownId) {
      return;
    }

    let current = true;

    loadCachedMessages(ownId, chatId).then((cached) => {
      if (current && cached?.length) {
        setMessages((loaded) => loaded ?? cached);
      }
    });

    return () => {
      current = false;
    };
  }, [ownId, chatId]);

  useEffect(() => {
    if (!ownId || messages === null) {
      return;
    }

    const timer = setTimeout(() => saveCachedMessages(ownId, chatId, messages), 1000);

    return () => clearTimeout(timer);
  }, [ownId, chatId, messages]);

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

  // Messages the server accepted from the outbox (also without the
  // realtime connection).
  useEffect(
    () =>
      outbox.subscribeSent((message) => {
        if (message.chat_id === chatId) {
          setMessages((current) => mergeMessages(current ?? [], [message]));
        }
      }),
    [outbox, chatId],
  );

  // The history with the own messages still on their way.
  const shownMessages = useMemo(() => {
    const loaded = messages ?? [];
    const pending = outbox.outgoing
      .filter((o) => o.chatId === chatId && !loaded.some((m) => m.id === o.id))
      .map(outgoingAsMessage);

    return pending.length ? mergeMessages(loaded, pending) : loaded;
  }, [messages, outbox.outgoing, chatId]);

  const outgoingOf = (message: Message): Outgoing | undefined =>
    (message as Message & { outgoing?: Outgoing }).outgoing;

  // Decrypted once per message.
  const texts = useMemo(
    () => new Map(shownMessages.map((m) => [m.id, crypto.decrypt(m)])),
    [shownMessages, crypto],
  );
  const textOf = (message: MessageRef & { content: string }): Shown =>
    texts.get(message.id) ?? crypto.decrypt(message);

  const rows = useMemo(
    () => buildRows(shownMessages, user?.id, unreadAfter),
    [shownMessages, user?.id, unreadAfter],
  );

  // Search: matching messages, newest first.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!searching || !needle) {
      return [];
    }

    return shownMessages
      .filter((m) => plainText(texts.get(m.id)?.text ?? "").toLowerCase().includes(needle))
      .map((m) => m.id)
      .reverse();
  }, [searching, query, shownMessages, texts]);

  const showError = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  const send = async () => {
    const content = draft.trim();

    if ((!content && picked.length === 0) || sending || uploading || keyChanged) {
      return;
    }

    if (editing) {
      if (!content) {
        return;
      }

      const target = editing;
      setSending(true);
      setDraft(drafts[chatId] ?? "");
      setEditing(null);
      setInputHeight(INPUT_MIN_HEIGHT);

      try {
        // The files stay; only the text changes.
        const payload = encodePayload({ text: content, attachments: textOf(target).attachments });
        const updated = await withToken((t) =>
          editMessage(t, chatId, target.id, crypto.encrypt(payload, target.id)),
        );
        setMessages((current) =>
          current?.map((m) => (m.id === updated.id ? updated : m)) ?? current,
        );
        setError(null);
      } catch (e) {
        setDraft(content);
        setEditing((current) => current ?? target);
        showError(e, "Failed to edit the message");
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }

      return;
    }

    if (!user || !crypto.canEncrypt) {
      showError(
        null,
        group
          ? "The group's key has not loaded yet"
          : `@${chat?.username ?? "…"} has not set up end-to-end encryption yet`,
      );
      return;
    }

    // Files are encrypted and uploaded first (that needs the network);
    // the message then goes through the outbox like any other.
    let attachments: Attachment[] = [];

    if (picked.length > 0) {
      setUploading(true);

      try {
        for (const file of picked) {
          attachments.push(await withToken((t) => uploadAttachment(t, file)));
        }
      } catch (e) {
        showError(e, "Failed to upload the file");
        attachments = [];
        return;
      } finally {
        setUploading(false);
      }
    }

    const id = newMessageId();
    let encrypted: string;

    try {
      encrypted = crypto.encrypt(encodePayload({ text: content, attachments }), id);
    } catch (e) {
      showError(e, "Failed to send message");
      return;
    }

    // Groups: the server is told whom it mentions, to notify them.
    const mentioned = new Set(mentionedUsernames(content));
    const mentions = group
      ? (members ?? [])
          .filter((m) => m.id !== user.id && mentioned.has(m.username.toLowerCase()))
          .map((m) => m.id)
      : [];

    // Shown at once and sent in the background (again later if offline).
    outbox.send({
      id,
      chatId,
      senderId: user.id,
      content: encrypted,
      replyTo: replyTo ? replyPreview(replyTo) : null,
      attachments: attachments.map((a) => a.id),
      ...(mentions.length ? { mentions } : {}),
    });

    setDraft("");
    storeDraft(chatId, "");
    setPicked([]);
    setInputHeight(INPUT_MIN_HEIGHT);
    // Own messages end the "unread" section.
    setUnreadAfter(null);
    setReplyTo(null);
    setError(null);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    inputRef.current?.focus();
  };

  // Adds a photo or a file to the next message.
  const attach = async (kind: "photo" | "file") => {
    setAttachMenu(false);

    try {
      const file = await (kind === "photo" ? pickPhoto() : pickDocument());

      if (file) {
        setPicked((current) => [...current, file].slice(0, MAX_ATTACHMENTS));
      }
    } catch (e) {
      showError(e, "Failed to open the file");
    }
  };

  // Saves the files of a message.
  const saveAttachments = async (message: Message) => {
    setMenuFor(null);

    try {
      for (const attachment of textOf(message).attachments ?? []) {
        const bytes = await withToken((t) => loadAttachment(t, attachment));
        await saveFile(bytes, attachment.name, attachment.mime);
      }
    } catch (e) {
      showError(e, "Failed to save the file");
    }
  };

  // The quote of a reply, as the server would show it.
  const replyPreview = (message: Message): ReplyPreview => ({
    id: message.id,
    sender_id: message.sender_id,
    sender_username:
      message.sender_id === user?.id ? (user?.username ?? "") : (chat?.username ?? message.sender_username),
    sender_is_developer:
      message.sender_id === user?.id ? Boolean(user?.is_developer) : Boolean(chat?.is_developer),
    content: message.content,
  });

  // Forwards a message: its text and files, encrypted for the other chat,
  // with whom it comes from. Files are copied on the server (same keys).
  const forward = async (message: Message, target: Chat) => {
    setForwarding(null);

    if (!user || !privateKey) {
      return;
    }

    const shown = textOf(message);
    const from =
      shown.forwardedFrom ??
      (message.sender_id === user.id ? user.username : (chat?.username ?? message.sender_username));

    let attachments: Attachment[] = [];

    try {
      attachments = await withToken((t) => copyAttachments(t, shown.attachments ?? []));
    } catch (e) {
      showError(e, "Failed to forward the files");
      return;
    }

    const id = newMessageId();
    let content: string;

    try {
      content = encryptForChat(
        target,
        encodePayload({ text: shown.text, forwardedFrom: from, attachments }),
        { id, sender_id: user.id },
        privateKey,
      );
    } catch (e) {
      showError(e, "Failed to forward the message");
      return;
    }

    outbox.send({
      id,
      chatId: target.id,
      senderId: user.id,
      content,
      replyTo: null,
      attachments: attachments.map((a) => a.id),
    });

    router.navigate({ pathname: "/chats/[chatId]", params: { chatId: target.id } });
  };

  const togglePin = async (message: Message | null) => {
    setMenuFor(null);
    setChatMenu(false);

    try {
      await pinMessage(chatId, message?.id ?? null);
    } catch (e) {
      showError(e, "Failed to pin the message");
    }
  };

  const startReply = (message: Message) => {
    setMenuFor(null);
    setEditing(null);
    setReplyTo(message);
    requestFocus();
  };

  const startEdit = (message: Message) => {
    setMenuFor(null);
    setReplyTo(null);
    setEditing(message);
    setDraft(textOf(message).text);
    requestFocus();
  };

  // Back to the draft that was there before editing.
  const cancelEdit = () => {
    setEditing(null);
    setDraft(drafts[chatId] ?? "");
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

    if (!editing) {
      storeDraft(chatId, text);
    }

    // "typing…" for the other member, at most every few seconds.
    if (text.trim() && !editing && typingDue(lastTypingSent)) {
      sendTyping(chatId);
    }
  };

  // Groups: members matching the "@…" being typed at the cursor.
  const mentionQuery = (() => {
    if (!group || editing) {
      return null;
    }

    const match = /(^|[^\w@])@([A-Za-z0-9_.-]{0,32})$/.exec(draft.slice(0, cursor ?? draft.length));
    return match ? match[2].toLowerCase() : null;
  })();

  const suggestions =
    mentionQuery === null
      ? []
      : (members ?? [])
          .filter((m) => m.id !== user?.id && m.username.toLowerCase().startsWith(mentionQuery))
          .slice(0, 6);

  const pickMention = (username: string) => {
    const end = cursor ?? draft.length;
    const before = draft.slice(0, end).replace(/@[A-Za-z0-9_.-]*$/, `@${username} `);

    onDraftChange(before + draft.slice(end));
    setCursor(before.length);
    requestFocus();
  };

  const toggleBlocked = async () => {
    if (!chat?.user_id) {
      return;
    }

    const peer = chat.user_id;

    setChatMenu(false);

    try {
      await withToken((t) => setBlocked(t, peer, !chat.blocked_by_me));
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

  const leave = async () => {
    setChatMenu(false);
    setShowGroupInfo(false);

    try {
      await leaveGroup(chatId);
      router.replace("/chats");
    } catch (e) {
      showError(e, "Failed to leave the group");
    }
  };

  // The direct chat with a group's member.
  const messageMember = async (username: string) => {
    try {
      const direct = await startChat(username);
      router.navigate({ pathname: "/chats/[chatId]", params: { chatId: direct.id } });
    } catch (e) {
      showError(e, "Failed to open the chat");
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

  // A message's actions; a message still on its way can only be sent
  // again, copied or dropped.
  const messageMenuItems = (message: Message): ActionMenuItem[] => {
    const pending = outgoingOf(message);
    const shown = textOf(message);
    const own = message.sender_id === user?.id;
    const copy: ActionMenuItem = { icon: "copy-outline", label: "Copy text", onPress: () => copyText(message) };

    if (pending) {
      return [
        ...(pending.state === "failed"
          ? [{
              icon: "refresh" as const,
              label: pending.error ? `Send again (${pending.error})` : "Send again",
              onPress: () => {
                setMenuFor(null);
                outbox.retry(message.id);
              },
            }]
          : []),
        copy,
        {
          icon: "trash-outline",
          label: "Delete",
          danger: true,
          onPress: () => {
            setMenuFor(null);
            outbox.discard(message.id);
          },
        },
      ];
    }

    const pinned = chat?.pinned_message?.id === message.id;
    const canPin = !group || groupAdmin;

    return [
      { icon: "arrow-undo-outline", label: "Reply", onPress: () => startReply(message) },
      ...(shown.attachments?.length
        ? [{
            icon: "download-outline" as const,
            label: shown.attachments.length > 1 ? "Save files" : isImage(shown.attachments[0].mime) ? "Save photo" : "Save file",
            onPress: () => saveAttachments(message),
          }]
        : []),
      copy,
      ...(shown.status === "ok"
        ? [{
            icon: "arrow-redo-outline" as const,
            label: "Forward",
            onPress: () => {
              setMenuFor(null);
              setForwarding(message);
            },
          }]
        : []),
      ...(canPin
        ? [{
            icon: pinned ? ("pin" as const) : ("pin-outline" as const),
            label: pinned ? "Unpin" : "Pin",
            onPress: () => togglePin(pinned ? null : message),
          }]
        : []),
      ...(own && !shown.forwardedFrom && shown.status === "ok"
        ? [{ icon: "create-outline" as const, label: "Edit", onPress: () => startEdit(message) }]
        : []),
      ...(own || groupAdmin
        ? [{
            icon: "trash-outline" as const,
            label: "Delete",
            confirmLabel: "Delete for everyone?",
            danger: true,
            onPress: () => removeMessage(message),
          }]
        : []),
    ];
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

    // Enter or Tab takes the first @mention suggestion.
    if (
      Platform.OS === "web" &&
      suggestions.length > 0 &&
      (nativeEvent.key === "Tab" || (nativeEvent.key === "Enter" && !nativeEvent.shiftKey))
    ) {
      event.preventDefault();
      pickMention(suggestions[0].username);
      return;
    }

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

  // Not in the list from the server (the saved list may just be old).
  if (synced && !chat) {
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
  const peerOnline = !group && status === "online" && Boolean(peerPresence?.online);
  const onlineMembers = (members ?? []).filter(
    (m) => m.id !== user?.id && presence[m.id]?.online,
  ).length;
  const statusText =
    status !== "online"
      ? status === "connecting"
        ? "connecting…"
        : "waiting for network…"
      : group
        ? `${chat?.member_count ?? 0} members${onlineMembers ? `, ${onlineMembers} online` : ""}`
        : saved
          ? "only you"
          : formatPresence(peerPresence);

  // Who is typing: in a group by name.
  const typingNames = (typingUsers[chatId] ?? []).map((id) => memberNames.get(id)).filter(Boolean);
  const typingText = !typing.has(chatId)
    ? null
    : group && typingNames.length
      ? typingNames.length === 1
        ? `@${typingNames[0]} is typing…`
        : `${typingNames.length} people are typing…`
      : "typing…";

  const peerReadAt = chat?.peer_last_read_at ?? null;
  const canSend =
    (Boolean(draft.trim()) || (picked.length > 0 && !editing)) && !sending && !uploading && !keyChanged;

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
            <Pressable
              onPress={() => (group ? setShowGroupInfo(true) : undefined)}
              disabled={!group}
              accessibilityRole={group ? "button" : undefined}
              accessibilityLabel={group ? "Group info" : undefined}
            >
              <ChatAvatar chat={chat} size={38} online={peerOnline} />
            </Pressable>
          ) : null
        }
        title={chat ? (chat.type === "direct" ? (chat.username ?? "…") : chatTitle(chat)) : "…"}
        titleBadge={chat?.is_developer ? <DevBadge size="md" /> : null}
        subtitle={
          typingText ? (
            <Text style={{ color: colors.accent }}>{typingText}</Text>
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

      {chat?.pinned_message ? (
        <View style={[styles.pinnedBar, { backgroundColor: colors.surface, borderBottomColor: colors.line }]}>
          <Pressable
            onPress={() => {
              const id = chat.pinned_message!.id;

              if (shownMessages.some((m) => m.id === id)) {
                showMessage(id);
              } else {
                setError("The pinned message is further up: scroll up to load it");
              }
            }}
            accessibilityRole="button"
            accessibilityLabel="Show the pinned message"
            style={[styles.pinnedText, { borderLeftColor: colors.accent }]}
          >
            <Text style={[styles.pinnedLabel, { color: colors.accent }]}>Pinned message</Text>
            <Text numberOfLines={1} style={[styles.pinnedPreview, { color: colors.textSoft }]}>
              {previewText(messagePreview(crypto.decrypt(chat.pinned_message)))}
            </Text>
          </Pressable>
          {!group || groupAdmin ? (
            <IconButton
              icon="close"
              label="Unpin"
              size={18}
              color={colors.muted}
              onPress={() => togglePin(null)}
            />
          ) : null}
        </View>
      ) : null}

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
                      {group
                        ? "Say hi to the group!"
                        : saved
                          ? "Keep notes, links and files here: end-to-end encrypted, on all your devices."
                          : `Say hi to @${chat?.username ?? "…"}!`}
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

                if (item.message.kind === "system") {
                  return (
                    <View style={styles.separator}>
                      <Text
                        style={[
                          styles.systemLabel,
                          { color: colors.muted, backgroundColor: colors.panel },
                        ]}
                      >
                        {textOf(item.message).text}
                      </Text>
                    </View>
                  );
                }

                return (
                  <MessageBubble
                    row={item}
                    senderName={
                      group
                        ? (memberNames.get(item.message.sender_id) ?? item.message.sender_username)
                        : undefined
                    }
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
                    sending={outgoingOf(item.message)?.state}
                    highlighted={item.message.id === highlightedId}
                    onReply={() => startReply(item.message)}
                    onMenu={() => setMenuFor(item.message)}
                    onQuotePress={showMessage}
                    onReact={(emoji) => react(item.message, emoji)}
                    onError={setError}
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
          <Text style={[styles.notice, { color: group && isGroupDistrusted(chat.id) ? colors.danger : colors.muted }]}>
            {group
              ? isGroupDistrusted(chat.id)
                ? "The group's key came from someone whose security key has changed. Compare safety codes in the group's info."
                : "Loading the group's key…"
              : `@${chat.username} has not set up end-to-end encryption yet. You can write once they open the updated Ostrich.`}
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
            {suggestions.length > 0 ? (
              <View style={[styles.suggestions, { borderBottomColor: colors.line }]}>
                {suggestions.map((member) => (
                  <Pressable
                    key={member.id}
                    onPress={() => pickMention(member.username)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention @${member.username}`}
                    style={({ hovered, pressed }) => [
                      styles.suggestion,
                      (hovered || pressed) && { backgroundColor: colors.hover },
                    ]}
                  >
                    <Avatar name={member.username} avatarId={member.avatar_id} size={26} />
                    <Text style={[styles.suggestionName, { color: colors.text }]}>@{member.username}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {editing ? (
              <View style={styles.replyBar}>
                <Ionicons name="create-outline" size={18} color={colors.accent} />
                <View style={[styles.replyBarText, { borderLeftColor: colors.accent }]}>
                  <Text style={[styles.replyBarName, { color: colors.accent }]}>
                    Edit message
                  </Text>
                  <Text numberOfLines={1} style={[styles.replyBarContent, { color: colors.muted }]}>
                    {previewText(messagePreview(textOf(editing)))}
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
                    {previewText(messagePreview(textOf(replyTo)))}
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

            {picked.length > 0 ? (
              <View style={styles.pickedBar}>
                {picked.map((file, i) => (
                  <View key={i} style={[styles.picked, { backgroundColor: colors.panelAlt }]}>
                    {file.previewUri ? (
                      <Image source={{ uri: file.previewUri }} style={styles.pickedThumb} contentFit="cover" />
                    ) : (
                      <Ionicons name="document-outline" size={20} color={colors.muted} />
                    )}
                    <View style={styles.pickedText}>
                      <Text numberOfLines={1} style={[styles.pickedName, { color: colors.text }]}>
                        {file.name}
                      </Text>
                      <Text style={[styles.pickedSize, { color: colors.muted }]}>
                        {uploading ? "Uploading…" : formatSize(file.bytes.length)}
                      </Text>
                    </View>
                    <IconButton
                      icon="close"
                      label={`Remove ${file.name}`}
                      size={16}
                      color={colors.muted}
                      disabled={uploading}
                      onPress={() => setPicked((current) => current.filter((_, j) => j !== i))}
                    />
                  </View>
                ))}
              </View>
            ) : null}

            <View style={styles.composerRow}>
              {editing ? null : (
                <IconButton
                  icon="attach"
                  label="Attach a photo or file"
                  size={22}
                  color={colors.muted}
                  disabled={uploading || picked.length >= MAX_ATTACHMENTS}
                  onPress={() => setAttachMenu(true)}
                />
              )}
              <View style={[styles.inputBox, { backgroundColor: colors.panelAlt }]}>
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={onDraftChange}
                  onKeyPress={onKeyPress}
                  onSelectionChange={(event) => setCursor(event.nativeEvent.selection.end)}
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
          title={previewText(messagePreview(textOf(menuFor)))}
          onClose={() => setMenuFor(null)}
          header={
            outgoingOf(menuFor) ? undefined : (
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
            )
          }
          items={messageMenuItems(menuFor)}
        />
      ) : null}

      {attachMenu ? (
        <ActionMenu
          title="Attach"
          onClose={() => setAttachMenu(false)}
          items={[
            { icon: "image-outline", label: "Photo", onPress: () => attach("photo") },
            { icon: "document-outline", label: "File (up to 25 MB)", onPress: () => attach("file") },
          ]}
        />
      ) : null}

      {forwarding ? (
        <ForwardPicker onPick={(target) => forward(forwarding, target)} onClose={() => setForwarding(null)} />
      ) : null}

      {chatMenu && chat && group ? (
        <ActionMenu
          title={chatTitle(chat)}
          onClose={() => setChatMenu(false)}
          items={[
            {
              icon: "people-outline",
              label: "Group info",
              onPress: () => {
                setChatMenu(false);
                setShowGroupInfo(true);
              },
            },
            { icon: "search", label: "Search in chat", onPress: openSearch },
            ...(chat.pinned_message && groupAdmin
              ? [{ icon: "pin-outline" as const, label: "Unpin message", onPress: () => togglePin(null) }]
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
              icon: "eye-off-outline",
              label: "Clear history for me",
              confirmLabel: "Clear? The others keep the messages",
              danger: true,
              onPress: () => deleteChat("me"),
            },
            {
              icon: "exit-outline",
              label: "Leave group",
              confirmLabel: "Leave the group?",
              danger: true,
              onPress: leave,
            },
            ...(chat.role === "owner"
              ? [{
                  icon: "trash-outline" as const,
                  label: "Delete group",
                  confirmLabel: "Delete the group for everyone?",
                  danger: true,
                  onPress: () => deleteChat("everyone"),
                }]
              : []),
          ]}
        />
      ) : null}

      {showGroupInfo && chat && group ? (
        <GroupInfo
          chat={chat}
          members={members}
          onChanged={() => {
            loadMembers();
            reloadChats();
          }}
          onLeave={leave}
          onDelete={() => {
            setShowGroupInfo(false);
            deleteChat("everyone");
          }}
          onMessage={(username) => {
            setShowGroupInfo(false);
            messageMember(username);
          }}
          onClose={() => setShowGroupInfo(false)}
        />
      ) : null}

      {chatMenu && chat && saved ? (
        <ActionMenu
          title={chatTitle(chat)}
          onClose={() => setChatMenu(false)}
          items={[
            { icon: "search", label: "Search in chat", onPress: openSearch },
            ...(chat.pinned_message
              ? [{ icon: "pin-outline" as const, label: "Unpin message", onPress: () => togglePin(null) }]
              : []),
            {
              icon: chat.pinned ? "pin" : "pin-outline",
              label: chat.pinned ? "Unpin" : "Pin to top",
              onPress: () => changeSettings({ pinned: !chat.pinned }),
            },
            {
              icon: "trash-outline",
              label: "Delete Saved messages",
              confirmLabel: "Delete all saved messages?",
              danger: true,
              onPress: () => deleteChat("everyone"),
            },
          ]}
        />
      ) : null}

      {chatMenu && chat && chat.type === "direct" ? (
        <ActionMenu
          title={`@${chat.username}`}
          onClose={() => setChatMenu(false)}
          items={[
            { icon: "search", label: "Search in chat", onPress: openSearch },
            ...(chat.pinned_message
              ? [{ icon: "pin-outline" as const, label: "Unpin message", onPress: () => togglePin(null) }]
              : []),
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
              confirmLabel: `Clear? @${chat.username} keeps the messages`,
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
          username={chat.username ?? ""}
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
    textAlign: "center",
    maxWidth: 300,
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

  suggestions: {
    paddingBottom: 6,
    marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },

  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.input,
  },

  suggestionName: {
    fontSize: 15,
  },

  systemLabel: {
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: "hidden",
    textAlign: "center",
    maxWidth: "90%",
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

  pickedBar: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingBottom: 8,
  },

  picked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 6,
    borderRadius: 12,
    maxWidth: 240,
  },

  pickedThumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
  },

  pickedText: {
    flexShrink: 1,
    paddingVertical: 4,
  },

  pickedName: {
    fontSize: 13,
    fontWeight: "600",
  },

  pickedSize: {
    fontSize: 11,
  },

  pinnedBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },

  pinnedText: {
    flex: 1,
    borderLeftWidth: 2,
    paddingLeft: 8,
  },

  pinnedLabel: {
    fontSize: 12,
    fontWeight: "700",
  },

  pinnedPreview: {
    fontSize: 13,
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
