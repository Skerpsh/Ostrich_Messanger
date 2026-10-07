import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import { useAppTheme } from "@/context/theme";

// Landing screen, same hero as the website.
export default function WelcomeScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();

  return (
    <View style={styles.screen}>
      <AppHeader brand title="Ostrich" />

      <View style={styles.hero}>
        <Image
          source={require("@/assets/images/Giuseppe.png")}
          style={styles.heroImage}
          contentFit="contain"
          accessibilityLabel="Giuseppe"
        />

        <Text style={[styles.title, { color: colors.text }]}>OSTRICH</Text>

        <Text style={[styles.subtitle, { color: colors.textSoft }]}>
          Anonymous. Fast. Secure.{"\n"}Chat without limits.
        </Text>

        <View style={styles.buttons}>
          <Button title="Log in" onPress={() => router.push("/login")} />
          <Button
            title="Create account"
            variant="secondary"
            onPress={() => router.push("/register")}
          />
        </View>
      </View>

      <Text
        style={[
          styles.footer,
          { color: colors.muted, borderTopColor: colors.line },
        ]}
      >
        © 2026 Ostrich Messenger. All rights reserved.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

  heroImage: {
    width: 180,
    height: 180,
    marginBottom: 20,
  },

  title: {
    fontSize: 48,
    fontWeight: "700",
    letterSpacing: 5,
    marginBottom: 12,
  },

  subtitle: {
    fontSize: 18,
    lineHeight: 30,
    textAlign: "center",
    maxWidth: 600,
  },

  buttons: {
    marginTop: 40,
    gap: 16,
    width: "100%",
    maxWidth: 320,
  },

  footer: {
    textAlign: "center",
    fontSize: 13,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
});
