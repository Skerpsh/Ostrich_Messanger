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

// "1234 5678 9012 3456": login IDs are easier to read in groups of four.
export function formatLoginId(loginId: string) {
  return loginId.replace(/(\d{4})(?=\d)/g, "$1 ");
}
