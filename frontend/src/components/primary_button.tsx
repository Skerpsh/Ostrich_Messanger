import {
  Pressable,
  Text,
  StyleSheet,
  type PressableProps,
} from "react-native";

interface PrimaryButtonProps extends PressableProps {
  title: string;
}

export default function PrimaryButton({
  title,
  ...props
}: PrimaryButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
      ]}
      {...props}
    >
      <Text style={styles.text}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 280,
    height: 52,
    borderRadius: 12,
    backgroundColor: "white",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 12,
  },

  pressed: {
    opacity: 0.7,
  },

  text: {
    color: "black",
    fontSize: 16,
    fontWeight: "600",
  },
});
