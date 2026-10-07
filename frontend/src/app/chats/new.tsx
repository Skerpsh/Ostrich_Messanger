import { useState } from "react";
import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { createChat } from "@/lib/api";
import { formatLoginId } from "@/lib/format";
import { rememberPeer } from "@/lib/peers";
import { radius } from "@/theme/colors";

export default function NewChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { seedPresence } = useRealtime();

  const [loginId, setLoginId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  const submit = async () => {
    // Allow pasting IDs with spaces ("1234 5678 ...").
    const id = loginId.replace(/\s/g, "");

    if (!/^\d{1,18}$/.test(id)) {
      setError("Login ID must contain only digits");
      return;
    }

    if (id === user?.login_id) {
      setError("This is your own login ID");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const chat = await withToken((token) => createChat(token, id));

      seedPresence([
        {
          userId: chat.user_id,
          presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
        },
      ]);

      rememberPeer(chat.id, {
        userId: chat.user_id,
        username: chat.username,
        loginId: chat.login_id,
      });
      router.replace({
        pathname: "/chats/[chatId]",
        params: { chatId: chat.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create chat");
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader onBack={close} title="NEW CHAT" />

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.card,
            { backgroundColor: colors.panel, borderColor: colors.line },
          ]}
        >
          <Text style={[styles.text, { color: colors.textSoft }]}>
            Enter the login ID of the person you want to chat with. They can
            find it on their chats screen.
          </Text>

          <TextField
            label="Login ID"
            placeholder={
              user ? formatLoginId(user.login_id).replace(/\d/g, "0") : ""
            }
            value={loginId}
            onChangeText={setLoginId}
            keyboardType="number-pad"
            maxLength={24}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          {error ? (
            <Text style={[styles.error, { color: colors.danger }]}>
              {error}
            </Text>
          ) : null}

          <Button title="Start chat" loading={loading} onPress={submit} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  body: {
    flex: 1,
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: radius.card,
    borderWidth: 1,
    padding: 24,
    gap: 20,
  },

  text: {
    fontSize: 15,
    lineHeight: 24,
  },

  error: {
    fontSize: 14,
  },
});
