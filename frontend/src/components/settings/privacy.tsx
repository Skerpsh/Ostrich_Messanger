import { useState } from "react";
import { Text } from "react-native";
import { useAuth, useCurrentUser } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { setPrivacy } from "@/lib/api";
import { Divider, Section, styles, ToggleRow } from "./ui";

export function PrivacySection() {
  const { withToken, updateUser } = useAuth();
  const user = useCurrentUser();
  const [error, setError] = useState<string | null>(null);
  const { colors } = useAppTheme();

  if (!user) {
    return null;
  }

  const change = async (privacy: { show_presence?: boolean; read_receipts?: boolean }) => {
    setError(null);
    // Show the change right away.
    await updateUser({ ...user, ...privacy });

    try {
      await updateUser(await withToken((token) => setPrivacy(token, privacy)));
    } catch (e) {
      await updateUser(user);
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  return (
    <Section title="Privacy">
      <ToggleRow
        icon="radio-button-on-outline"
        label="Show when I'm online"
        hint="Off: nobody sees your online status or when you were last seen."
        value={user.show_presence}
        onChange={(value) => change({ show_presence: value })}
      />
      <Divider />
      <ToggleRow
        icon="checkmark-done-outline"
        label="Read receipts"
        hint="Off: others don't see when you've read their messages, and you don't see theirs."
        value={user.read_receipts}
        onChange={(value) => change({ read_receipts: value })}
      />
      {error ? (
        <Text style={[styles.formMessage, styles.inset, { color: colors.danger }]}>{error}</Text>
      ) : null}
    </Section>
  );
}
