import type { ReactNode } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { IconName } from "@/components/icon-button";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// Building blocks of the settings screen and its styles.

// A row with an on/off switch.
export function ToggleRow({
  icon,
  label,
  hint,
  value,
  onChange,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.toggleRow}>
      <Ionicons name={icon} size={20} color={colors.muted} />
      <View style={styles.toggleText}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {hint ? (
          <Text style={[styles.toggleHint, { color: colors.muted }]}>{hint}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: colors.panelAlt, true: colors.accent }}
        thumbColor="#ffffff"
        {...({ activeThumbColor: "#ffffff" } as object)}
      />
    </View>
  );
}

export function Section({
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

// Rows with icons have the divider start after the icon.
export function Divider({ full = false }: { full?: boolean }) {
  const { colors } = useAppTheme();

  return (
    <View
      style={[
        styles.divider,
        full && styles.dividerFull,
        { backgroundColor: colors.line },
      ]}
    />
  );
}

export function Row({
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

export const styles = StyleSheet.create({
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

  usernameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  username: {
    flexShrink: 1,
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

  photo: {
    alignItems: "center",
    gap: 8,
  },

  photoBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },

  photoAction: {
    fontSize: 13,
    fontWeight: "600",
  },

  photoError: {
    fontSize: 13,
    textAlign: "center",
  },

  accentBlock: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 12,
  },

  accentLabel: {
    fontSize: 15,
  },

  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },

  swatchRing: {
    padding: 3,
    borderRadius: 22,
    borderWidth: 2,
  },

  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
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

  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },

  toggleText: {
    flex: 1,
    gap: 2,
  },

  toggleHint: {
    fontSize: 13,
    lineHeight: 18,
  },

  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },

  deviceButton: {
    minHeight: 36,
    paddingHorizontal: 14,
  },

  loadingRow: {
    padding: 16,
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 50,
  },

  dividerFull: {
    marginLeft: 0,
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
