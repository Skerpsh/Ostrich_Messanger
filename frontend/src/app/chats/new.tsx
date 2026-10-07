import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useChats } from "@/context/chats";
import { useRealtime } from "@/context/realtime";
import { useAppTheme } from "@/context/theme";
import { createChat } from "@/lib/api";
import { useIsWide } from "@/lib/layout";
import { radius } from "@/theme/colors";

// Same rules as the backend.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export default function NewChatScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const wide = useIsWide();
  const { withToken } = useAuth();
  const user = useCurrentUser();
  const { seedPresence } = useRealtime();
  const { addChat } = useChats();

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const close = () =>
    wide || !router.canGoBack() ? router.replace("/chats") : router.back();

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
      addChat(chat);

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
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AppHeader
        onBack={wide ? undefined : close}
        onClose={wide ? close : undefined}
        title="New chat"
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, { backgroundColor: colors.panel }]}>
            <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
              <Ionicons name="person-add-outline" size={26} color={colors.accent} />
            </View>

            <Text style={[styles.text, { color: colors.textSoft }]}>
              Enter the exact @username of the person you want to chat with.
              They can find it in their settings.
            </Text>

            <TextField
              label="Username"
              placeholder="@username"
              value={username}
              onChangeText={(text) => {
                setUsername(text);
                setError(null);
              }}
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
        </ScrollView>
      </KeyboardAvoidingView>
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
    gap: 18,
    marginTop: 12,
  },

  icon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },

  text: {
    fontSize: 15,
    lineHeight: 22,
  },

  error: {
    fontSize: 14,
  },
});
