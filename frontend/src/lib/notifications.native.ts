// Mobile apps: push notifications through Expo. The server sends one for a
// new message when the app is closed (no open connection) and the chat is
// not muted; it only says "New message", since the text is encrypted.
import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { removePushToken, savePushToken } from "./api";
import { getItem, setItem } from "./storage";

const PREF_KEY = "ostrich-notifications";

type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

// While the app is open the chat updates live, so no banner is needed
// (the server does not push to open apps anyway).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export function notificationsSupported() {
  // Simulators cannot receive push notifications.
  return Device.isDevice;
}

export async function notificationsEnabled() {
  if (!notificationsSupported() || (await getItem(PREF_KEY)) === "off") {
    return false;
  }

  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted";
}

async function registerPushToken(withToken: WithToken) {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });

  await withToken((token) => savePushToken(token, data));
}

export async function enableNotifications(withToken: WithToken) {
  if (!notificationsSupported()) {
    return false;
  }

  const current = await Notifications.getPermissionsAsync();
  const { status } =
    current.status === "granted"
      ? current
      : await Notifications.requestPermissionsAsync();

  if (status !== "granted") {
    await setItem(PREF_KEY, "off");
    return false;
  }

  await setItem(PREF_KEY, "on");
  await registerPushToken(withToken);
  return true;
}

export async function disableNotifications(withToken: WithToken) {
  await setItem(PREF_KEY, "off");
  await withToken(removePushToken).catch(() => {});
}

// At startup: refresh this session's push token (tokens can change, and a
// new login has a new session). Asks for permission the first time.
export async function syncPushToken(withToken: WithToken) {
  if (!notificationsSupported() || (await getItem(PREF_KEY)) === "off") {
    return;
  }

  try {
    await enableNotifications(withToken);
  } catch {
    // No network or no push credentials yet: try again next start.
  }
}

// Push notifications never contain the text (the server cannot read it).
export function notificationPreviewsSupported() {
  return false;
}

export async function notificationPreviewsEnabled() {
  return false;
}

export async function setNotificationPreviews(_enabled: boolean) {}

// The app shows new messages itself, so nothing to show here.
export async function showMessageNotification(
  _title: string,
  _body: string,
  _chatId: string,
  _openChat: (chatId: string) => void,
) {}

// Tapping a notification opens its chat (also when it started the app).
export function useNotificationTaps(openChat: (chatId: string) => void) {
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const chatId = response?.notification.request.content.data?.chatId;

      if (typeof chatId === "string") {
        openChat(chatId);
      }
    };

    Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);

    return () => subscription.remove();
  }, [openChat]);
}
