import { useState, type ReactNode } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
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
import Avatar from "@/components/avatar";
import Button from "@/components/button";
import type { IconName } from "@/components/icon-button";
import TextField from "@/components/text-field";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme, type ThemePreference } from "@/context/theme";
import { changePassword, changeUsername } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useIsWide } from "@/lib/layout";
import { radius } from "@/theme/colors";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
// Same rules as the backend.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: IconName }[] =
  [
    { value: "system", label: "System", icon: "phone-portrait-outline" },
    { value: "light", label: "Light", icon: "sunny-outline" },
    { value: "dark", label: "Dark", icon: "moon-outline" },
  ];

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, preference, setPreference } = useAppTheme();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const { signOut, signOutEverywhere } = useAuth();
  const user = useCurrentUser();

  const [open, setOpen] = useState<"username" | "password" | null>(null);
  const [copied, setCopied] = useState(false);

  // Logging out everywhere takes a second tap, so it is not done by accident.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  if (!user) {
    return null;
  }

  const close = () =>
    wide || !router.canGoBack() ? router.replace("/chats") : router.back();

  const toggle = (section: "username" | "password") =>
    setOpen((current) => (current === section ? null : section));

  const copyUsername = async () => {
    await Clipboard.setStringAsync(`@${user.username}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <AppHeader
        onBack={wide ? undefined : close}
        onClose={wide ? close : undefined}
        title="Settings"
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.body,
            { paddingBottom: insets.bottom + 32 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.profile, { backgroundColor: colors.panel }]}>
            <Avatar name={user.username} size={72} />
            <Text style={[styles.username, { color: colors.text }]}>
              @{user.username}
            </Text>
            <Pressable
              onPress={copyUsername}
              accessibilityRole="button"
              accessibilityLabel="Copy your username"
              style={({ hovered }) => [
                styles.chip,
                { backgroundColor: colors.accentSoft },
                hovered && styles.hovered,
              ]}
            >
              <Ionicons
                name={copied ? "checkmark" : "copy-outline"}
                size={15}
                color={colors.accent}
              />
              <Text style={[styles.chipText, { color: colors.accent }]}>
                {copied ? "Copied" : "Copy username"}
              </Text>
            </Pressable>
            <Text style={[styles.hint, { color: colors.muted }]}>
              Friends start chats with you by your username.
            </Text>
          </View>

          <Section title="Appearance">
            <View style={[styles.segmented, { backgroundColor: colors.panelAlt }]}>
              {THEME_OPTIONS.map((option) => {
                const selected = preference === option.value;

                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setPreference(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    style={[
                      styles.segment,
                      selected && {
                        backgroundColor: colors.panel,
                        boxShadow: `0 1px 4px ${colors.shadow}`,
                      },
                    ]}
                  >
                    <Ionicons
                      name={option.icon}
                      size={16}
                      color={selected ? colors.accent : colors.muted}
                    />
                    <Text
                      style={[
                        styles.segmentText,
                        { color: selected ? colors.text : colors.muted },
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title="Account">
            <Row
              icon="at"
              label="Username"
              value={`@${user.username}`}
              expanded={open === "username"}
              onPress={() => toggle("username")}
            />
            {open === "username" ? <UsernameForm /> : null}
            <Divider />
            <Row
              icon="key-outline"
              label="Password"
              expanded={open === "password"}
              onPress={() => toggle("password")}
            />
            {open === "password" ? <PasswordForm /> : null}
          </Section>

          <Section
            title="Security"
            footer="Log out everywhere if you think someone else has access to your account. You will need your username, password and OstrichID to log in again."
          >
            <Row
              icon="phone-portrait-outline"
              label={
                confirmingSignOut
                  ? "Tap again to log out on all devices"
                  : "Log out of all devices"
              }
              danger
              loading={signingOut}
              onPress={signOutAll}
            />
            {signOutError ? (
              <Text style={[styles.formMessage, styles.inset, { color: colors.danger }]}>
                {signOutError}
              </Text>
            ) : null}
          </Section>

          <Section>
            <Row icon="log-out-outline" label="Log out" onPress={signOut} />
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.section}>
      {title ? (
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>
          {title}
        </Text>
      ) : null}
      <View style={[styles.sectionCard, { backgroundColor: colors.panel }]}>
        {children}
      </View>
      {footer ? (
        <Text style={[styles.sectionFooter, { color: colors.muted }]}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

function Divider() {
  const { colors } = useAppTheme();

  return <View style={[styles.divider, { backgroundColor: colors.line }]} />;
}

function Row({
  icon,
  label,
  value,
  expanded,
  danger = false,
  loading = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  value?: string;
  // Rows that open a form show a chevron pointing down / up.
  expanded?: boolean;
  danger?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const color = danger ? colors.danger : colors.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      style={({ hovered, pressed }) => [
        styles.row,
        (hovered || pressed) && { backgroundColor: colors.hover },
      ]}
    >
      <Ionicons name={icon} size={20} color={danger ? colors.danger : colors.muted} />
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      {value ? (
        <Text numberOfLines={1} style={[styles.rowValue, { color: colors.muted }]}>
          {value}
        </Text>
      ) : null}
      {loading ? (
        <ActivityIndicator color={color} />
      ) : expanded !== undefined ? (
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.muted}
        />
      ) : null}
    </Pressable>
  );
}

function UsernameForm() {
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

    const name = username.trim().replace(/^@/, "");

    if (!USERNAME_RE.test(name)) {
      setError("Username: 3–32 characters, letters, digits, _ . - only");
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

function PasswordForm() {
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

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  body: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    padding: 16,
    gap: 22,
  },

  profile: {
    alignItems: "center",
    gap: 10,
    borderRadius: radius.card,
    paddingVertical: 24,
    paddingHorizontal: 16,
  },

  username: {
    fontSize: 22,
    fontWeight: "700",
  },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },

  chipText: {
    fontSize: 14,
    fontWeight: "600",
  },

  hovered: {
    opacity: 0.85,
  },

  hint: {
    fontSize: 13,
    textAlign: "center",
  },

  section: {
    gap: 8,
  },

  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 14,
  },

  sectionCard: {
    borderRadius: radius.card,
    overflow: "hidden",
  },

  sectionFooter: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 14,
  },

  segmented: {
    flexDirection: "row",
    margin: 10,
    padding: 3,
    borderRadius: 12,
  },

  segment: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
  },

  segmentText: {
    fontSize: 14,
    fontWeight: "600",
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 52,
    paddingHorizontal: 16,
  },

  rowLabel: {
    flex: 1,
    fontSize: 16,
  },

  rowValue: {
    fontSize: 15,
    maxWidth: "50%",
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 50,
  },

  form: {
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 18,
  },

  formText: {
    fontSize: 14,
    lineHeight: 20,
  },

  formMessage: {
    fontSize: 14,
  },

  inset: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
});
