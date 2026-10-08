import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import DevBadge from "@/components/dev-badge";
import QrCode from "@/components/qr-code";
import type { IconName } from "@/components/icon-button";
import {
  DeleteAccountForm,
  PasswordForm,
  UsernameForm,
} from "@/components/settings/account-forms";
import { DevicesSection } from "@/components/settings/devices";
import { NotificationsSection } from "@/components/settings/notifications";
import { PrivacySection } from "@/components/settings/privacy";
import { ProfilePhoto } from "@/components/settings/profile-photo";
import { Divider, Row, Section, styles } from "@/components/settings/ui";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme, type ThemePreference } from "@/context/theme";
import { useIsWide } from "@/lib/layout";
import { profileLink } from "@/lib/links";
import { accents } from "@/theme/colors";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: IconName }[] =
  [
    { value: "system", label: "System", icon: "phone-portrait-outline" },
    { value: "light", label: "Light", icon: "sunny-outline" },
    { value: "dark", label: "Dark", icon: "moon-outline" },
  ];

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, mode, preference, setPreference, accentId, setAccent } =
    useAppTheme();
  const insets = useSafeAreaInsets();
  const wide = useIsWide();
  const { signOut, signOutEverywhere } = useAuth();
  const user = useCurrentUser();

  const [open, setOpen] = useState<"username" | "password" | "delete" | null>(null);
  const [copied, setCopied] = useState(false);
  // The profile's QR code (scanned, it opens a chat with the user).
  const [showQr, setShowQr] = useState(false);

  // Logging out everywhere takes a second tap, so it is not done by accident.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  if (!user) {
    return null;
  }

  const close = () =>
    wide || !router.canGoBack() ? router.replace("/chats") : router.back();

  const toggle = (section: "username" | "password" | "delete") =>
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
            <ProfilePhoto />
            <View style={styles.usernameRow}>
              <Text style={[styles.username, { color: colors.text }]}>
                @{user.username}
              </Text>
              {user.is_developer ? <DevBadge size="lg" /> : null}
            </View>
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
            <Pressable
              onPress={() => setShowQr((shown) => !shown)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showQr }}
              style={({ hovered }) => [
                styles.chip,
                { backgroundColor: colors.accentSoft },
                hovered && styles.hovered,
              ]}
            >
              <Ionicons name="qr-code-outline" size={15} color={colors.accent} />
              <Text style={[styles.chipText, { color: colors.accent }]}>
                {showQr ? "Hide QR code" : "My QR code"}
              </Text>
            </Pressable>
            {showQr ? (
              <>
                <QrCode value={profileLink(user.username)} />
                <Text selectable style={[styles.hint, { color: colors.muted }]}>
                  {profileLink(user.username)}
                </Text>
              </>
            ) : null}
            <Text style={[styles.hint, { color: colors.muted }]}>
              Friends start chats with you by your username, or by scanning
              your QR code.
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
            <Divider full />
            <View style={styles.accentBlock}>
              <Text style={[styles.accentLabel, { color: colors.textSoft }]}>
                Accent color
              </Text>
              <View style={styles.swatches}>
                {accents.map((accent) => {
                  const selected = accent.id === accentId;
                  const variant = accent[mode];

                  return (
                    <Pressable
                      key={accent.id}
                      onPress={() => setAccent(accent.id)}
                      accessibilityRole="radio"
                      accessibilityLabel={accent.name}
                      accessibilityState={{ checked: selected }}
                      {...({ title: accent.name } as object)}
                      style={[
                        styles.swatchRing,
                        { borderColor: selected ? variant.accent : "transparent" },
                      ]}
                    >
                      <View
                        style={[styles.swatch, { backgroundColor: variant.accent }]}
                      >
                        {selected ? (
                          <Ionicons
                            name="checkmark"
                            size={18}
                            color={variant.onAccent}
                          />
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
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

          <PrivacySection />

          <NotificationsSection />

          <DevicesSection />

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

          <Section title="Danger zone">
            <Row
              icon="trash-outline"
              label="Delete account"
              danger
              expanded={open === "delete"}
              onPress={() => toggle("delete")}
            />
            {open === "delete" ? <DeleteAccountForm /> : null}
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
