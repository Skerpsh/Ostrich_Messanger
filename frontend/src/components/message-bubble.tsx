import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Animated, PanResponder, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import AttachmentView from "@/components/attachment-view";
import DevBadge from "@/components/dev-badge";
import IconButton from "@/components/icon-button";
import MarkupText from "@/components/markup-text";
import { useAppTheme } from "@/context/theme";
import type { Reaction } from "@/lib/api";
import type { MessageRow } from "@/lib/chat-rows";
import { formatTime, previewText } from "@/lib/format";
import { messagePreview } from "@/lib/preview";
import type { Shown } from "@/lib/use-chat-crypto";
import { radius } from "@/theme/colors";

// Phones and tablets (also their browsers): swipe left to reply, long press
// for the menu. Mouse users get a reply button on hover instead, and can
// select text by dragging.
export const TOUCH_UI =
  Platform.OS !== "web" ||
  (typeof window !== "undefined" &&
    Boolean(window.matchMedia?.("(pointer: coarse)").matches));

// How far a bubble follows the finger, and how far it must go to reply.
const SWIPE_MAX = 72;
const SWIPE_REPLY_AT = 48;

export default function MessageBubble({
  row,
  read,
  ownId,
  text,
  quoteText,
  sending,
  highlighted,
  onReply,
  onMenu,
  onQuotePress,
  onReact,
  onError,
}: {
  row: MessageRow;
  read: boolean;
  ownId: string | undefined;
  // The decrypted message and the message it replies to.
  text: Shown;
  quoteText: Shown | null;
  // Own message still on its way, or refused by the server.
  sending?: "sending" | "failed";
  highlighted: boolean;
  onReply: () => void;
  // Long press / right click: the message's actions.
  onMenu: () => void;
  onQuotePress: (messageId: string) => void;
  // Tapping a reaction under the message toggles yours.
  onReact: (emoji: string) => void;
  // A file could not be loaded or saved.
  onError: (message: string) => void;
}) {
  const { colors } = useAppTheme();
  const [hovered, setHovered] = useState(false);
  const { message, own, joinedAbove, joinedBelow } = row;
  const swipe = useSwipeToReply(onReply);
  const quote = message.reply_to;

  // The corners next to the bubble's neighbours in its group are smaller.
  const side = own ? "Right" : "Left";
  const corners = {
    [`borderTop${side}Radius`]: joinedAbove ? radius.bubbleJoined : radius.bubble,
    [`borderBottom${side}Radius`]: joinedBelow ? radius.bubbleJoined : radius.bubble,
  };

  const textColor = own ? colors.onAccent : colors.text;
  const metaColor = own ? colors.onAccent : colors.muted;

  // Mouse: a reply button next to the hovered bubble.
  const replyButton =
    !TOUCH_UI && hovered ? (
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
    <View
      // pointerenter/leave are not fired when the pointer moves onto the
      // reply button inside the row, so the button stays while used.
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      {...swipe.handlers}
      style={[
        styles.row,
        own ? styles.rowOwn : styles.rowOther,
        { marginTop: joinedAbove ? 2 : 10 },
        highlighted && { backgroundColor: colors.accentSoft },
        styles.rowHighlightable,
        TOUCH_UI && styles.rowTouch,
      ]}
    >
      {own ? replyButton : null}

      <Animated.View
        style={[styles.bubbleWrap, { transform: [{ translateX: swipe.offset }] }]}
      >
        <Pressable
          onLongPress={onMenu}
          delayLongPress={350}
          // Web: right click opens the message menu instead of the browser's.
          {...({
            onContextMenu: (event: { preventDefault: () => void }) => {
              event.preventDefault();
              onMenu();
            },
          } as object)}
          style={[
            styles.bubble,
            corners,
            { backgroundColor: own ? colors.accent : colors.panel },
          ]}
        >
          {quote && quoteText ? (
            <Pressable
              onPress={() => onQuotePress(quote.id)}
              accessibilityRole="button"
              accessibilityLabel={`Reply to ${quote.sender_username}: ${quoteText.text}`}
              style={[
                styles.quote,
                {
                  borderLeftColor: own ? colors.onAccent : colors.accent,
                  backgroundColor: own ? "rgba(0, 0, 0, 0.12)" : colors.accentSoft,
                },
              ]}
            >
              <View style={styles.quoteNameRow}>
                <Text
                  numberOfLines={1}
                  style={[styles.quoteName, { color: own ? colors.onAccent : colors.accent }]}
                >
                  {quote.sender_id === ownId ? "You" : quote.sender_username}
                </Text>
                {quote.sender_is_developer ? <DevBadge /> : null}
              </View>
              <Text
                numberOfLines={2}
                style={[
                  styles.quoteText,
                  { color: own ? colors.onAccent : colors.textSoft },
                  quoteText.status === "error" && styles.unreadable,
                ]}
              >
                {previewText(messagePreview(quoteText))}
              </Text>
            </Pressable>
          ) : null}

          {text.forwardedFrom ? (
            <Text style={[styles.forwarded, { color: own ? colors.onAccent : colors.accent }]}>
              Forwarded from @{text.forwardedFrom}
            </Text>
          ) : null}
          {text.attachments?.length ? (
            <AttachmentView attachments={text.attachments} own={own} onError={onError} />
          ) : null}
          {text.status === "ok" && !text.text && text.attachments?.length ? null : text.status === "ok" ? (
            <MarkupText
              text={text.text}
              // Touch screens copy through the long-press menu; selecting
              // text there would take over the long press.
              selectable={!TOUCH_UI}
              style={[styles.content, { color: textColor }]}
              codeBackground={own ? "rgba(0, 0, 0, 0.16)" : colors.panelAlt}
              linkColor={own ? colors.onAccent : colors.accent}
            />
          ) : (
            <Text
              selectable={!TOUCH_UI}
              style={[styles.content, { color: textColor }, text.status === "error" && styles.unreadable]}
            >
              {text.text}
            </Text>
          )}
          {message.reactions.length > 0 ? (
            <View style={styles.reactions}>
              {groupReactions(message.reactions, ownId).map(({ emoji, count, mine }) => (
                <Pressable
                  key={emoji}
                  onPress={() => onReact(emoji)}
                  accessibilityRole="button"
                  accessibilityLabel={`${emoji} ${count}${mine ? ", yours" : ""}`}
                  style={[
                    styles.reactionChip,
                    {
                      backgroundColor: own
                        ? "rgba(0, 0, 0, 0.14)"
                        : mine
                          ? colors.accentSoft
                          : colors.panelAlt,
                      borderColor: mine ? (own ? colors.onAccent : colors.accent) : "transparent",
                    },
                  ]}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                  {count > 1 ? (
                    <Text style={[styles.reactionCount, { color: textColor }]}>{count}</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.bubbleMeta}>
            {text.status === "plain" ? (
              // Not end-to-end encrypted: from before encryption, or not
              // from the other member at all (only the server could have
              // put it there).
              <View
                style={styles.plain}
                accessibilityLabel="not end-to-end encrypted"
                {...({ title: "Not end-to-end encrypted" } as object)}
              >
                <Ionicons name="lock-open-outline" size={11} color={metaColor} />
                <Text style={[styles.time, { color: metaColor }]}>not encrypted</Text>
              </View>
            ) : null}
            {message.edited_at ? (
              <Text style={[styles.time, { color: metaColor }]}>edited</Text>
            ) : null}
            <Text style={[styles.time, { color: metaColor }]}>
              {formatTime(message.created_at)}
            </Text>
            {sending === "failed" ? (
              <Text style={[styles.time, styles.failed, { color: metaColor }]}>⚠ Not sent</Text>
            ) : sending ? (
              <Ionicons name="time-outline" size={13} color={metaColor} accessibilityLabel="sending" />
            ) : own ? (
              <Ionicons
                name={read ? "checkmark-done" : "checkmark"}
                size={14}
                color={metaColor}
                accessibilityLabel={read ? "read" : "sent"}
              />
            ) : null}
          </View>
        </Pressable>
      </Animated.View>

      {own ? null : replyButton}

      {TOUCH_UI ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.swipeIcon,
            { backgroundColor: colors.panelAlt, opacity: swipe.progress, transform: [{ scale: swipe.progress }] },
          ]}
        >
          <Ionicons name="arrow-undo" size={18} color={colors.accent} />
        </Animated.View>
      ) : null}
    </View>
  );
}

// Reactions as chips: emoji, how many, whether one is yours.
function groupReactions(reactions: Reaction[], ownId: string | undefined) {
  const groups = new Map<string, { emoji: string; count: number; mine: boolean }>();

  for (const r of reactions) {
    const group = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    group.count++;
    group.mine ||= r.user_id === ownId;
    groups.set(r.emoji, group);
  }

  return [...groups.values()];
}

// Swipe a bubble to the left to reply: it follows the finger up to
// SWIPE_MAX, an arrow fades in on the right, and letting go past
// SWIPE_REPLY_AT replies. Only clearly horizontal moves to the left are
// taken, so scrolling the chat keeps working.
function useSwipeToReply(onReply: () => void) {
  const [offset] = useState(() => new Animated.Value(0));
  const onReplyRef = useRef(onReply);

  useLayoutEffect(() => {
    onReplyRef.current = onReply;
  });

  const handlers = useMemo(() => {
    if (!TOUCH_UI) {
      return {};
    }

    const settle = () =>
      Animated.spring(offset, {
        toValue: 0,
        useNativeDriver: Platform.OS !== "web",
        speed: 20,
        bounciness: 6,
      }).start();

    const isSwipe = (dx: number, dy: number) =>
      dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.5;

    // The ref is read in the gesture handlers, not while rendering.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      // Capture: take the gesture from the bubble's long press once the
      // finger clearly moves left.
      onMoveShouldSetPanResponderCapture: (_, g) => isSwipe(g.dx, g.dy),
      onMoveShouldSetPanResponder: (_, g) => isSwipe(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) =>
        offset.setValue(Math.max(-SWIPE_MAX, Math.min(0, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx <= -SWIPE_REPLY_AT) {
          onReplyRef.current();
        }

        settle();
      },
      onPanResponderTerminate: settle,
    }).panHandlers;
  }, [offset]);

  // 0 at rest, 1 once the swipe would reply.
  const progress = useMemo(
    () =>
      offset.interpolate({
        inputRange: [-SWIPE_REPLY_AT, 0],
        outputRange: [1, 0],
        extrapolate: "clamp",
      }),
    [offset],
  );

  return { offset, progress, handlers };
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },

  rowHighlightable: {
    borderRadius: radius.bubble,
  },

  // Browsers keep vertical scrolling and leave horizontal moves to the
  // swipe.
  rowTouch: Platform.OS === "web" ? ({ touchAction: "pan-y" } as object) : {},

  rowOwn: {
    justifyContent: "flex-end",
    paddingLeft: 48,
  },

  rowOther: {
    justifyContent: "flex-start",
    paddingRight: 48,
  },

  bubbleWrap: {
    flexShrink: 1,
    maxWidth: 560,
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

  swipeIcon: {
    position: "absolute",
    right: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
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

  quoteNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },

  quoteName: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
  },

  quoteText: {
    fontSize: 13,
    lineHeight: 18,
    opacity: 0.9,
  },

  content: {
    fontSize: 16,
    lineHeight: 22,
  },

  forwarded: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 2,
  },

  failed: {
    opacity: 1,
    fontWeight: "700",
  },

  unreadable: {
    fontStyle: "italic",
    opacity: 0.8,
  },

  reactions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 4,
  },

  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },

  reactionEmoji: {
    fontSize: 14,
  },

  reactionCount: {
    fontSize: 12,
    fontWeight: "600",
  },

  bubbleMeta: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 3,
    marginTop: 1,
  },

  plain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginRight: 2,
  },

  time: {
    fontSize: 11,
    opacity: 0.75,
  },
});
