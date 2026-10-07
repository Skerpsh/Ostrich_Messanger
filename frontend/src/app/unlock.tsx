import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// A device logged in without the account's keys (e.g. from before
// end-to-end encryption): the OstrichID unlocks them, once per device.
export default function UnlockScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { unlock, signOut } = useAuth();
  const user = useCurrentUser();

  const [ostrichId, setOstrichId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);

    try {
      await unlock(ostrichId.trim());
      // The navigator moves on to the chats on its own.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader brand title="Ostrich" subtitle={user ? `@${user.username}` : undefined} />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, { backgroundColor: colors.panel }]}>
            <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
              <Ionicons name="lock-closed" size={26} color={colors.accent} />
            </View>
            <Text style={[styles.title, { color: colors.text }]}>
              Unlock your messages
            </Text>
            <Text style={[styles.text, { color: colors.textSoft }]}>
              Ostrich now encrypts messages end to end: only you and the person
              you talk to can read them, not even the server. Enter your
              OstrichID once on this device to unlock them.
            </Text>

            <TextField
              label="OstrichID"
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              value={ostrichId}
              onChangeText={setOstrichId}
              maxLength={40}
              autoCapitalize="characters"
              autoComplete="off"
              autoFocus
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            {error ? (
              <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
            ) : null}

            <Button title="Unlock" loading={loading} onPress={submit} />

            <Pressable onPress={signOut} accessibilityRole="button" style={styles.logout}>
              <Text style={[styles.logoutText, { color: colors.muted }]}>
                Log out instead
              </Text>
            </Pressable>
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

  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: radius.card,
    padding: 24,
    gap: 16,
  },

  icon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },

  title: {
    fontSize: 24,
    fontWeight: "700",
  },

  text: {
    fontSize: 15,
    lineHeight: 22,
  },

  error: {
    fontSize: 14,
  },

  logout: {
    alignSelf: "center",
    padding: 4,
  },

  logoutText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
