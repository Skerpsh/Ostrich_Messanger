import type { Message } from "./api";
import { formatDayLabel } from "./format";

// Messages of one sender closer than this are drawn as one group.
const GROUP_GAP_MS = 5 * 60 * 1000;

export type Row =
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

export type MessageRow = Extract<Row, { type: "message" }>;

export const time = (iso: string) => new Date(iso).getTime();

function byTime(a: Message, b: Message) {
  return time(a.created_at) - time(b.created_at) || a.id.localeCompare(b.id);
}

// Adds messages, dropping duplicates (a message can arrive both from the
// websocket and from a history reload), oldest first.
export function mergeMessages(current: Message[], incoming: Message[]) {
  const byId = new Map(current.map((message) => [message.id, message]));

  for (const message of incoming) {
    byId.set(message.id, message);
  }

  return [...byId.values()].sort(byTime);
}

// Merges a freshly loaded page of the newest history: messages within the
// time span of the page that are not in it were deleted meanwhile (e.g.
// while offline) and are dropped. `complete`: the page reaches back to the
// start of the chat, so everything older than it is gone as well.
export function reconcileHistory(
  current: Message[],
  page: Message[],
  complete: boolean,
) {
  if (page.length === 0) {
    return complete ? [] : current;
  }

  const ids = new Set(page.map((message) => message.id));
  const from = complete ? -Infinity : time(page[0].created_at);
  const to = time(page[page.length - 1].created_at);

  const kept = current.filter((message) => {
    const at = time(message.created_at);

    return ids.has(message.id) || at < from || at > to;
  });

  return mergeMessages(kept, page);
}

// Day separators, the "unread" line and bubble groups, newest first (the
// list is inverted so it starts at the bottom).
export function buildRows(
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
