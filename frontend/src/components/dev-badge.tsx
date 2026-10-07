import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text } from "react-native";

// The "DEV" badge next to the names of developer accounts. The flag comes
// from the server only; usernames cannot contain spaces or brackets, so
// the badge cannot be imitated with text.
//
// Colors: #2E2CB8 → #44AAB8 → #7FED53, with the blue end lightened so the
// dark letters stay readable across the whole badge (≥ 5:1).
const GRADIENT = ["#7c7bf0", "#44aab8", "#7fed53"] as const;
const LOCATIONS = [0, 0.45, 1] as const;
const TEXT = "#071036";

const SIZES = {
  sm: { fontSize: 10, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5 },
  md: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
  lg: { fontSize: 13, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7 },
};

export default function DevBadge({ size = "sm" }: { size?: keyof typeof SIZES }) {
  const { fontSize, ...box } = SIZES[size];

  return (
    <LinearGradient
      colors={GRADIENT}
      locations={LOCATIONS}
      // About 120°, as in the preview.
      start={{ x: 0, y: 0.2 }}
      end={{ x: 1, y: 0.8 }}
      style={[styles.badge, box]}
      accessibilityRole="text"
      accessibilityLabel="Developer"
    >
      <Text style={[styles.text, { fontSize, lineHeight: fontSize * 1.15 }]}>
        DEV
      </Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "center",
    flexShrink: 0,
  },

  text: {
    color: TEXT,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
});
