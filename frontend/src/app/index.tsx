import { View, Text, Image, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import PrimaryButton from "../components/primary_button";


export default function StartScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Image
        source={require("../assets/images/Giuseppe.png")}
        style={styles.logoImage}
        resizeMode="contain"
      />

      <Text style={styles.logo}>
        Ostrich
      </Text>

      <Text style={styles.subtitle}>
        Welcome to private chatting
      </Text>

      <View style={styles.buttons}>
        <PrimaryButton
          title="Generate New Account"
          onPress={() => router.push("/register")}
        />

        <PrimaryButton
          title="Login In Existing Account"
          onPress={() => router.push("/login")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "black",
  },

  logoImage: {
    width: 160,
    height: 160,
  },

  logo: {
    marginTop: 10,
    color: "white",
    fontSize: 42,
    fontWeight: "700",
  },

  subtitle: {
    marginTop: 8,
    color: "white",
    fontSize: 16,
  },

  buttons: {
    marginTop: 32,
    alignItems: "center",
  },
});
