import { useState } from "react";
import * as Clipboard from "expo-clipboard";
import {
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
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// Shown once after registration: the OstrichID is generated on this device
// and never sent to the server, so this is the only chance to save it.

// How long a copied OstrichID stays in the clipboard (apps only: browsers
// ask for permission to read the clipboard).
const CLIPBOARD_CLEAR_MS = 60_000;
export default function OstrichIdScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { state, confirmOstrichIdSaved } = useAuth();

  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const signedIn = state.status === "signedIn" ? state : null;
  const ostrichId = signedIn?.pendingOstrichId;

  if (!signedIn || !ostrichId) {
    return null;
  }

  const copy = async () => {
    await Clipboard.setStringAsync(ostrichId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);

    // Other apps can read the clipboard: take the ID out again once it has
    // had time to be pasted, unless something else was copied since.
    if (Platform.OS !== "web") {
      setTimeout(async () => {
        if ((await Clipboard.getStringAsync()) === ostrichId) {
          await Clipboard.setStringAsync("");
        }
      }, CLIPBOARD_CLEAR_MS);
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader brand title="Ostrich" subtitle={`@${signedIn.user.username}`} />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View
          style={[
            styles.card,
            { backgroundColor: colors.panel },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.muted }]}>
            Your OstrichID
          </Text>

          <Pressable
            onPress={copy}
            accessibilityRole="button"
            accessibilityLabel="Copy your OstrichID"
            style={[
              styles.idBox,
              { backgroundColor: colors.accentSoft, borderColor: colors.accent },
            ]}
          >
            <Text selectable style={[styles.id, { color: colors.text }]}>
              {ostrichId}
            </Text>
            <Text style={[styles.hint, { color: colors.muted }]}>
              {copied ? "Copied!" : "Tap to copy"}
            </Text>
          </Pressable>

          <Text style={[styles.text, { color: colors.textSoft }]}>
            You need it to log in, together with your username and password.
          </Text>
          <Text style={[styles.warning, { color: colors.danger }]}>
            It is shown only this once. Ostrich cannot show it again or
            recover it: if you lose it, you lose access to your account.
          </Text>
          <Text style={[styles.text, { color: colors.textSoft }]}>
            Save it somewhere safe, such as a password manager.
          </Text>

          <Pressable
            onPress={() => setSaved((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: saved }}
            style={styles.checkRow}
          >
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: saved ? colors.accent : colors.muted,
                  backgroundColor: saved ? colors.accent : "transparent",
                },
              ]}
            >
              {saved ? (
                <Text style={[styles.checkMark, { color: colors.onAccent }]}>✓</Text>
              ) : null}
            </View>
            <Text style={[styles.checkLabel, { color: colors.text }]}>
              I have saved my OstrichID
            </Text>
          </Pressable>

          <Button
            title="Continue"
            disabled={!saved}
            onPress={confirmOstrichIdSaved}
          />
        </View>
      </ScrollView>
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
    maxWidth: 480,
    alignSelf: "center",
    borderRadius: radius.card,
    padding: 24,
    gap: 18,
  },

  eyebrow: {
    fontSize: 12,
    letterSpacing: 3,
    textTransform: "uppercase",
  },

  idBox: {
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 6,
  },

  id: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 1,
    fontFamily: "monospace",
    textAlign: "center",
  },

  hint: {
    fontSize: 13,
  },

  text: {
    fontSize: 15,
    lineHeight: 22,
  },

  warning: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
  },

  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },

  checkMark: {
    fontSize: 16,
    fontWeight: "700",
  },

  checkLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
});
