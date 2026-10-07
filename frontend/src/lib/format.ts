function pad(n: number) {
  return String(n).padStart(2, "0");
}

// "14:05" for times, used in message bubbles.
export function formatTime(iso: string) {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// "14:05" today, "12.09" this year, "12.09.2025" otherwise.
export function formatChatDate(iso: string) {
  const date = new Date(iso);
  const now = new Date();

  if (date.toDateString() === now.toDateString()) {
    return formatTime(iso);
  }

  const dayMonth = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;

  return date.getFullYear() === now.getFullYear()
    ? dayMonth
    : `${dayMonth}.${date.getFullYear()}`;
}

// "12.09.2025".
export function formatDate(iso: string) {
  const date = new Date(iso);

  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

// "online", "last seen just now", "last seen 5 min ago",
// "last seen today at 14:05", "last seen yesterday at 14:05",
// "last seen 12.09 at 14:05".
export function formatPresence(
  presence: { online: boolean; lastSeenAt: string | null } | undefined,
) {
  if (!presence) {
    return "";
  }

  if (presence.online) {
    return "online";
  }

  if (!presence.lastSeenAt) {
    return "offline";
  }

  const date = new Date(presence.lastSeenAt);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);

  if (minutes < 1) {
    return "last seen just now";
  }

  if (minutes < 60) {
    return `last seen ${minutes} min ago`;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const time = formatTime(presence.lastSeenAt);

  if (date.toDateString() === new Date().toDateString()) {
    return `last seen today at ${time}`;
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return `last seen yesterday at ${time}`;
  }

  return `last seen ${formatChatDate(presence.lastSeenAt)} at ${time}`;
}
