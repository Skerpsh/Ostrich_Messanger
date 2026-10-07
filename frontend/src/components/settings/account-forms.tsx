import { useState } from "react";
import { Text, View } from "react-native";
import Button from "@/components/button";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { changePassword, changeUsername, deleteAccount } from "@/lib/api";
import { deriveFromOstrichId, normalizeOstrichId } from "@/lib/crypto";
import { formatDate } from "@/lib/format";
import {
  cleanUsername,
  MAX_PASSWORD,
  MIN_PASSWORD,
  USERNAME_RE,
  USERNAME_RULES,
} from "@/lib/validation";
import { styles } from "./ui";

// The forms that open under Account and Danger zone.

export function UsernameForm() {
  const { colors } = useAppTheme();
  const { withToken, updateUser } = useAuth();
  const user = useCurrentUser();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  // Once per 28 days (the first time right after registration).
  const next =
    user?.next_username_change_at &&
    new Date(user.next_username_change_at) > new Date()
      ? user.next_username_change_at
      : null;

  const submit = async () => {
    setDone(false);

    const name = cleanUsername(username);

    if (!USERNAME_RE.test(name)) {
      setError(USERNAME_RULES);
      return;
    }

    if (!password) {
      setError("Password is required");
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const updated = await withToken((token) =>
        changeUsername(token, name, password),
      );
      await updateUser(updated);
      setUsername("");
      setPassword("");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change username");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.form}>
      <Text style={[styles.formText, { color: colors.textSoft }]}>
        You log in with your username, and others find you by it. It can be
        changed once every 28 days.
      </Text>

      {done ? (
        <Text style={[styles.formMessage, { color: colors.online }]}>
          Username changed. Use the new one to log in.
        </Text>
      ) : null}

      {next ? (
        <Text style={[styles.formMessage, { color: colors.muted }]}>
          You can change it again on {formatDate(next)}.
        </Text>
      ) : (
        <>
          <TextField
            label="New username"
            placeholder="@username"
            value={username}
            onChangeText={setUsername}
            maxLength={33}
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            maxLength={MAX_PASSWORD}
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          {error ? (
            <Text style={[styles.formMessage, { color: colors.danger }]}>
              {error}
            </Text>
          ) : null}

          <Button title="Change username" loading={saving} onPress={submit} />
        </>
      )}
    </View>
  );
}

export function PasswordForm() {
  const { colors } = useAppTheme();
  const { withToken } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setDone(false);

    if (!currentPassword) {
      setError("Current password is required");
      return;
    }

    if (newPassword.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }

    setError(null);
    setSaving(true);

    try {
      await withToken((token) =>
        changePassword(token, currentPassword, newPassword),
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.form}>
      <Text style={[styles.formText, { color: colors.textSoft }]}>
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
        onSubmitEditing={submit}
      />

      {error ? (
        <Text style={[styles.formMessage, { color: colors.danger }]}>{error}</Text>
      ) : null}
      {done ? (
        <Text style={[styles.formMessage, { color: colors.online }]}>
          Password changed. Other devices have been logged out.
        </Text>
      ) : null}

      <Button title="Change password" loading={saving} onPress={submit} />
    </View>
  );
}

// Needs the password and the OstrichID: deleting is final.
export function DeleteAccountForm() {
  const { colors } = useAppTheme();
  const { state, withToken, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [ostrichId, setOstrichId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const submit = async () => {
    setError(null);
    const id = normalizeOstrichId(ostrichId);

    if (!password || !id) {
      setError("Enter your password and OstrichID");
      return;
    }

    if (!confirming) {
      setConfirming(true);
      return;
    }

    setDeleting(true);

    try {
      await withToken((token) =>
        deleteAccount(token, password, deriveFromOstrichId(id).authKey),
      );
      await signOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete the account");
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (state.status !== "signedIn") {
    return null;
  }

  return (
    <View style={styles.form}>
      <Text style={[styles.formText, { color: colors.textSoft }]}>
        Deletes your account, all your chats (for the people you talk to as
        well) and your messages. This cannot be undone. Your username becomes
        free for others.
      </Text>
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        maxLength={MAX_PASSWORD}
      />
      <TextField
        label="OstrichID"
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
        value={ostrichId}
        onChangeText={setOstrichId}
        autoCapitalize="characters"
        autoComplete="off"
        maxLength={40}
      />
      {error ? (
        <Text style={[styles.formMessage, { color: colors.danger }]}>{error}</Text>
      ) : null}
      <Button
        title={confirming ? "Delete forever?" : "Delete account"}
        variant="danger"
        loading={deleting}
        onPress={submit}
      />
    </View>
  );
}
