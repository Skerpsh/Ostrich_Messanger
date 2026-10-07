import { useEffect, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, Text, View } from "react-native";
import Button from "@/components/button";
import type { IconName } from "@/components/icon-button";
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { endSession, getSessions, type Session } from "@/lib/api";
import { formatChatDate, formatDate } from "@/lib/format";
import { Divider, Section, styles } from "./ui";

const CLIENT_NAMES: Record<string, { name: string; icon: IconName }> = {
  web: { name: "Web browser", icon: "globe-outline" },
  ios: { name: "iPhone / iPad", icon: "phone-portrait-outline" },
  android: { name: "Android", icon: "phone-portrait-outline" },
  macos: { name: "Mac", icon: "laptop-outline" },
  windows: { name: "Windows", icon: "laptop-outline" },
  cli: { name: "Terminal (CLI)", icon: "terminal-outline" },
};

export function DevicesSection() {
  const { withToken } = useAuth();
  const { colors } = useAppTheme();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped to load the list again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;

    withToken(getSessions).then(
      (loaded) => current && setSessions(loaded),
      (e) =>
        current && setError(e instanceof Error ? e.message : "Failed to load devices"),
    );

    return () => {
      current = false;
    };
  }, [withToken, version]);

  const end = async (session: Session) => {
    try {
      await withToken((token) => endSession(token, session.id));
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log out the device");
    }
  };

  return (
    <Section title="Devices">
      {sessions === null ? (
        <ActivityIndicator color={colors.muted} style={styles.loadingRow} />
      ) : (
        sessions.map((session, index) => {
          const client = CLIENT_NAMES[session.client ?? ""] ?? {
            name: "Unknown app",
            icon: "help-circle-outline" as IconName,
          };

          return (
            <View key={session.id}>
              {index > 0 ? <Divider /> : null}
              <View style={styles.deviceRow}>
                <Ionicons name={client.icon} size={20} color={colors.muted} />
                <View style={styles.toggleText}>
                  <Text style={[styles.rowLabel, { color: colors.text }]}>{client.name}</Text>
                  <Text style={[styles.toggleHint, { color: session.current ? colors.online : colors.muted }]}>
                    {session.current
                      ? "This device"
                      : `Active ${formatChatDate(session.last_used_at)} · since ${formatDate(session.created_at)}`}
                  </Text>
                </View>
                {session.current ? null : (
                  <Button
                    title="Log out"
                    variant="secondary"
                    onPress={() => end(session)}
                    style={styles.deviceButton}
                  />
                )}
              </View>
            </View>
          );
        })
      )}
      {error ? (
        <Text style={[styles.formMessage, styles.inset, { color: colors.danger }]}>{error}</Text>
      ) : null}
    </Section>
  );
}
