import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Button from "@/components/button";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// The chat's safety code over a dimmed background (placed like
// ActionMenu). `keyChanged`: the other member's key is not the one this
// device saw before; confirming accepts the new key.
export default function SafetyCode({
  username,
  code,
  keyChanged,
  onConfirm,
  onClose,
}: {
  username: string;
  code: string[];
  keyChanged: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
      <Pressable style={[styles.card, { backgroundColor: colors.panel }]} onPress={() => {}}>
        <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
          <Ionicons
            name={keyChanged ? "warning-outline" : "shield-checkmark-outline"}
            size={24}
            color={keyChanged ? colors.danger : colors.accent}
          />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>
          Safety code with @{username}
        </Text>

        <View style={[styles.code, { backgroundColor: colors.panelAlt }]}>
          {[code.slice(0, 4), code.slice(4)].map((line, i) => (
            <Text key={i} selectable style={[styles.codeLine, { color: colors.text }]}>
              {line.join("  ")}
            </Text>
          ))}
        </View>

        <Text style={[styles.text, { color: colors.textSoft }]}>
          Compare it with the code @{username} sees for this chat, in person
          or over another app. If both are the same, your messages are
          readable only by the two of you.
        </Text>

        {keyChanged ? (
          <Text style={[styles.text, { color: colors.danger }]}>
            The security key of @{username} has changed. That happens when they
            set up encryption again, but it can also mean someone is trying to
            read the chat. Write only after you have compared the codes.
          </Text>
        ) : null}

        {keyChanged ? (
          <Button title="The codes are the same" onPress={onConfirm} />
        ) : null}
        <Button title="Close" variant="secondary" onPress={onClose} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },

  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: radius.card,
    padding: 22,
    gap: 14,
  },

  icon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },

  title: {
    fontSize: 18,
    fontWeight: "700",
  },

  code: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    gap: 4,
  },

  codeLine: {
    fontSize: 18,
    fontFamily: "monospace",
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },

  text: {
    fontSize: 14,
    lineHeight: 20,
  },
});
