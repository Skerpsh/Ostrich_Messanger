import { useState, type Ref } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

type TextFieldProps = TextInputProps & {
  label?: string;
  // Small text under the field.
  hint?: string;
  ref?: Ref<TextInput>;
};

// Web draws its own focus ring around inputs; the field shows focus with
// its border instead.
export const noWebOutline =
  Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null;

export default function TextField({
  label,
  hint,
  style,
  ref,
  onFocus,
  onBlur,
  ...props
}: TextFieldProps) {
  const { colors } = useAppTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.field}>
      {label ? (
        <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      ) : null}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.panelAlt,
            borderColor: focused ? colors.accent : "transparent",
          },
          noWebOutline,
          style,
        ]}
        {...props}
      />
      {hint ? (
        <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 6,
  },

  label: {
    fontSize: 13,
    fontWeight: "600",
  },

  input: {
    height: 48,
    borderRadius: radius.input,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    fontSize: 16,
  },

  hint: {
    fontSize: 13,
    lineHeight: 18,
  },
});
