import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import {
  disableNotifications,
  enableNotifications,
  notificationPreviewsEnabled,
  notificationPreviewsSupported,
  notificationsEnabled,
  notificationsSupported,
  setNotificationPreviews,
} from "@/lib/notifications";
import { Divider, Section, styles, ToggleRow } from "./ui";

export function NotificationsSection() {
  const { withToken } = useAuth();
  const { colors } = useAppTheme();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [previews, setPreviews] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    notificationsEnabled().then(setEnabled);
    notificationPreviewsEnabled().then(setPreviews);
  }, []);

  const changePreviews = (value: boolean) => {
    setPreviews(value);
    setNotificationPreviews(value);
  };

  if (!notificationsSupported()) {
    return null;
  }

  const change = async (value: boolean) => {
    setError(null);

    try {
      if (value) {
        const granted = await enableNotifications(withToken);
        setEnabled(granted);

        if (!granted) {
          setError(
            Platform.OS === "web"
              ? "Notifications are blocked for this site. Allow them in the browser's site settings."
              : "Notifications are turned off for Ostrich in the system settings.",
          );
        }
      } else {
        await disableNotifications(withToken);
        setEnabled(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change notifications");
    }
  };

  return (
    <Section
      title="Notifications"
      footer={
        Platform.OS === "web"
          ? "While Ostrich is open in a tab. Muted chats stay quiet."
          : "Only “New message”: the text is end-to-end encrypted. Muted chats stay quiet."
      }
    >
      <ToggleRow
        icon="notifications-outline"
        label={Platform.OS === "web" ? "Desktop notifications" : "Push notifications"}
        value={enabled ?? false}
        disabled={enabled === null}
        onChange={change}
      />
      {enabled && notificationPreviewsSupported() ? (
        <>
          <Divider />
          <ToggleRow
            icon="eye-outline"
            label="Show message text"
            hint="Off: notifications only say “New message”, so the text does not appear on a locked or shared screen."
            value={previews}
            onChange={changePreviews}
          />
        </>
      ) : null}
      {error ? (
        <Text style={[styles.formMessage, styles.inset, { color: colors.danger }]}>{error}</Text>
      ) : null}
    </Section>
  );
}
