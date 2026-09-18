import { View, Text, StyleSheet } from "react-native";
import PrimaryButton from "../components/primary_button";

export default function RegisterScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create Account</Text>

      <PrimaryButton
        title="Generate Account"
        onPress={() => {
          console.log("Generate account");
        }}
      />

      <PrimaryButton
        title="Back"
        onPress={() => {
          console.log("Back");
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "black",
  },

  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "white",
    marginBottom: 20,
  },
});
