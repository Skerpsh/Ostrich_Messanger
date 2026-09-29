import type { ReactNode } from "react";
import { Image } from "expo-image";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "@/context/theme";
import ThemeToggle from "./theme-toggle";

type AppHeaderProps = {
  // Shows a back arrow instead of the logo.
  onBack?: () => void;
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
};

// The website's black top bar.
export default function AppHeader({
  onBack,
  title,
  subtitle,
  right,
}: AppHeaderProps) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 12,
          backgroundColor: colors.header,
          borderBottomColor: colors.line,
        },
      ]}
    >
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          hitSlop={12}
          style={styles.back}
        >
          <Text style={[styles.backIcon, { color: colors.text }]}>‹</Text>
        </Pressable>
      ) : (
        <Image
          source={require("@/assets/images/Giuseppe.png")}
          style={styles.logo}
          contentFit="contain"
          accessibilityLabel="Ostrich"
        />
      )}

      <View style={styles.titles}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {title ?? "OSTRICH"}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={[styles.subtitle, { color: colors.muted }]}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {right}
        <ThemeToggle />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },

  logo: {
    width: 40,
    height: 40,
  },

  back: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },

  backIcon: {
    fontSize: 36,
    lineHeight: 40,
    fontWeight: "300",
  },

  titles: {
    flex: 1,
  },

  title: {
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 2,
  },

  subtitle: {
    marginTop: 2,
    fontSize: 12,
  },

  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
