// Web: browser notifications for new messages while Ostrich is open in a
// tab (also in the background). The mobile apps use push notifications
// instead, see notifications.native.ts.
import { getItem, setItem } from "./storage";

const PREF_KEY = "ostrich-notifications";

type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function notificationsEnabled() {
  return (
    notificationsSupported() &&
    Notification.permission === "granted" &&
    (await getItem(PREF_KEY)) !== "off"
  );
}

// Asks the browser for permission (needs a click). False if refused.
export async function enableNotifications(_withToken: WithToken) {
  if (!notificationsSupported()) {
    return false;
  }

  const permission = await Notification.requestPermission();
  await setItem(PREF_KEY, permission === "granted" ? "on" : "off");

  return permission === "granted";
}

export async function disableNotifications(_withToken: WithToken) {
  await setItem(PREF_KEY, "off");
}

// Shown by the chats list for an incoming message; clicking it brings the
// tab forward and opens the chat.
export async function showMessageNotification(
  title: string,
  body: string,
  chatId: string,
  openChat: (chatId: string) => void,
) {
  if (!(await notificationsEnabled())) {
    return;
  }

  const notification = new Notification(title, {
    body,
    // One per chat: a newer message replaces the older notification.
    tag: chatId,
    icon: "/favicon.ico",
  });

  notification.onclick = () => {
    window.focus();
    openChat(chatId);
    notification.close();
  };
}

// Native only.
export async function syncPushToken(_withToken: WithToken) {}

export function useNotificationTaps(_openChat: (chatId: string) => void) {}
