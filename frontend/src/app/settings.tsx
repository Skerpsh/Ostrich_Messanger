import { useState } from "react";
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
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { changePassword } from "@/lib/api";
import { radius } from "@/theme/colors";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const { withToken, signOutEverywhere } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState(false);
  const [saving, setSaving] = useState(false);

  // Signing out everywhere takes a second tap, so it is not done by accident.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/chats");

  const submitPassword = async () => {
    setPasswordDone(false);

    if (!currentPassword) {
      setPasswordError("Current password is required");
      return;
    }

    if (newPassword.length < MIN_PASSWORD) {
      setPasswordError(
        `New password must be at least ${MIN_PASSWORD} characters`,
      );
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }

    setPasswordError(null);
    setSaving(true);

    try {
      await withToken((token) =>
        changePassword(token, currentPassword, newPassword),
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordDone(true);
    } catch (e) {
      setPasswordError(
        e instanceof Error ? e.message : "Failed to change password",
      );
    } finally {
      setSaving(false);
    }
  };

  const signOutAll = async () => {
    if (!confirmingSignOut) {
      setConfirmingSignOut(true);
      return;
    }

    setSignOutError(null);
    setSigningOut(true);

    try {
      await signOutEverywhere();
    } catch (e) {
      setSignOutError(e instanceof Error ? e.message : "Failed to log out");
      setSigningOut(false);
      setConfirmingSignOut(false);
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader onBack={close} title="SETTINGS" />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={[
              styles.card,
              { backgroundColor: colors.panel, borderColor: colors.line },
            ]}
          >
            <Text style={[styles.section, { color: colors.text }]}>
              Change password
            </Text>
            <Text style={[styles.text, { color: colors.textSoft }]}>
              Your other devices will be logged out.
            </Text>

            <TextField
              label="Current password"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
              autoComplete="current-password"
              maxLength={MAX_PASSWORD}
            />
            <TextField
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              autoComplete="new-password"
              maxLength={MAX_PASSWORD}
            />
            <TextField
              label="Confirm new password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              autoComplete="new-password"
              maxLength={MAX_PASSWORD}
              returnKeyType="go"
              onSubmitEditing={submitPassword}
            />

            {passwordError ? (
              <Text style={[styles.message, { color: colors.danger }]}>
                {passwordError}
              </Text>
            ) : null}
            {passwordDone ? (
              <Text style={[styles.message, { color: colors.online }]}>
                Password changed. Other devices have been logged out.
              </Text>
            ) : null}

            <Button
              title="Change password"
              loading={saving}
              onPress={submitPassword}
            />
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: colors.panel, borderColor: colors.line },
            ]}
          >
            <Text style={[styles.section, { color: colors.text }]}>
              Devices
            </Text>
            <Text style={[styles.text, { color: colors.textSoft }]}>
              Log out on every device where you are signed in, including this
              one. Use it if you think someone else has access to your account.
            </Text>

            {signOutError ? (
              <Text style={[styles.message, { color: colors.danger }]}>
                {signOutError}
              </Text>
            ) : null}

            <Button
              title={
                confirmingSignOut
                  ? "Tap again to confirm"
                  : "Log out of all devices"
              }
              variant="secondary"
              loading={signingOut}
              onPress={signOutAll}
            />
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
    gap: 20,
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

  section: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 1,
  },

  text: {
    fontSize: 15,
    lineHeight: 24,
  },

  message: {
    fontSize: 14,
  },
});
