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
import { rememberPeer } from "@/lib/peers";
import { radius } from "@/theme/colors";

// Same rules as the backend.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export default function NewChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { seedPresence } = useRealtime();

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  const submit = async () => {
    // "@alice" and "alice" both work.
    const name = username.trim().replace(/^@/, "");

    if (!USERNAME_RE.test(name)) {
      setError("Username: 3–32 characters, letters, digits, _ . - only");
      return;
    }

    if (name.toLowerCase() === user?.username.toLowerCase()) {
      setError("This is your own username");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const chat = await withToken((token) => createChat(token, name));

      seedPresence([
        {
          userId: chat.user_id,
          presence: { online: chat.online, lastSeenAt: chat.last_seen_at },
        },
      ]);

      rememberPeer(chat.id, {
        userId: chat.user_id,
        username: chat.username,
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
            Enter the exact @username of the person you want to chat with.
            They can find it on their chats screen.
          </Text>

          <TextField
            label="Username"
            placeholder="@username"
            value={username}
            onChangeText={setUsername}
            maxLength={33}
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
