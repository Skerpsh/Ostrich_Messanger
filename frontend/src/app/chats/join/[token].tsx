import { useCallback, useEffect, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import { useAuth } from "@/context/auth";
import { useChats } from "@/context/chats";
import { useAppTheme } from "@/context/theme";
import { cancelJoinRequest, getInviteInfo, requestToJoin, type InviteInfo } from "@/lib/api";
import { useIsWide } from "@/lib/layout";
import { radius } from "@/theme/colors";

// An invite link to a group: asks to join; an admin lets the user in.
// The group's name is encrypted, so it shows once the user is a member.
export default function JoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { colors } = useAppTheme();
  const wide = useIsWide();
  const { withToken } = useAuth();
  // The list changes when the user is let in: checked again then.
  const { chats } = useChats();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    withToken((t) => getInviteInfo(t, token)).then(
      (next) => {
        setInfo(next);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : "Failed to open the invite"),
    );
  }, [withToken, token]);

  useEffect(() => {
    load();
  }, [load, chats?.length]);

  const close = () => (wide || !router.canGoBack() ? router.replace("/chats") : router.back());

  const act = async (action: (t: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);

    try {
      await withToken(action);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AppHeader onBack={wide ? undefined : close} onClose={wide ? close : undefined} title="Group invite" />

      <View style={styles.body}>
        <View style={[styles.card, { backgroundColor: colors.panel }]}>
          <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
            <Ionicons name="people-outline" size={28} color={colors.accent} />
          </View>

          {!info && !error ? <ActivityIndicator color={colors.muted} /> : null}

          {info ? (
            <>
              <Text style={[styles.title, { color: colors.text }]}>
                {info.invited_by ? `@${info.invited_by} invites you to a group` : "An invite to a group"}
              </Text>
              <Text style={[styles.text, { color: colors.textSoft }]}>
                {info.member_count} members. Its name and messages are end-to-end encrypted:
                you see them once an admin lets you in.
              </Text>

              {info.status === "member" && info.chat_id ? (
                <Button
                  title="Open the group"
                  onPress={() =>
                    router.replace({ pathname: "/chats/[chatId]", params: { chatId: info.chat_id! } })
                  }
                />
              ) : info.status === "requested" ? (
                <>
                  <Text style={[styles.text, { color: colors.accent }]}>
                    Asked to join: waiting for an admin.
                  </Text>
                  <Button
                    title="Take the request back"
                    variant="secondary"
                    loading={busy}
                    onPress={() => act((t) => cancelJoinRequest(t, token))}
                  />
                </>
              ) : (
                <Button title="Ask to join" loading={busy} onPress={() => act((t) => requestToJoin(t, token))} />
              )}
            </>
          ) : null}

          {error ? <Text style={[styles.text, { color: colors.danger }]}>{error}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  body: {
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: radius.card,
    padding: 24,
    gap: 16,
    marginTop: 12,
  },

  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  title: {
    fontSize: 18,
    fontWeight: "700",
  },

  text: {
    fontSize: 15,
    lineHeight: 22,
  },
});
