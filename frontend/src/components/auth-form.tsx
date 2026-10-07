import { useRef, useState } from "react";
import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AppHeader from "@/components/app-header";
import Button from "@/components/button";
import TextField from "@/components/text-field";
import { useAuth } from "@/context/auth";
import { useAppTheme } from "@/context/theme";
import { radius } from "@/theme/colors";

// Same rules as the backend.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;

type AuthFormProps = {
  mode: "login" | "register";
};

export default function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { signIn, signUp, notice } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ostrichId, setOstrichId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const ostrichIdRef = useRef<TextInput>(null);

  const isRegister = mode === "register";

  const submit = async () => {
    // "@alice" works too.
    const name = username.trim().replace(/^@/, "");

    if (!name || !password) {
      setError("Username and password are required");
      return;
    }

    if (isRegister) {
      if (!USERNAME_RE.test(name)) {
        setError("Username: 3–32 characters, letters, digits, _ . - only");
        return;
      }

      if (password.length < MIN_PASSWORD) {
        setError(`Password must be at least ${MIN_PASSWORD} characters`);
        return;
      }

      if (password !== confirmPassword) {
        setError("Passwords do not match");
        return;
      }
    }

    setError(null);
    setLoading(true);

    try {
      await (isRegister
        ? signUp(name, password)
        : signIn(name, password, ostrichId.trim()));
      // The navigator switches to the chats screen on its own.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  const shownError = error ?? (isRegister ? null : notice);

  return (
    <View style={styles.screen}>
      <AppHeader
        brand
        title="Ostrich"
        onBack={router.canGoBack() ? router.back : undefined}
      />

      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.panel,
                boxShadow: `0 10px 30px ${colors.shadow}`,
              },
            ]}
          >
            <Text style={[styles.eyebrow, { color: colors.muted }]}>
              {isRegister ? "New account" : "Welcome back"}
            </Text>
            <Text style={[styles.title, { color: colors.text }]}>
              {isRegister ? "Create account" : "Log in"}
            </Text>

            <View style={styles.fields}>
              <TextField
                label="Username"
                placeholder="@username"
                value={username}
                onChangeText={setUsername}
                maxLength={33}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => passwordRef.current?.focus()}
                autoFocus={Platform.OS === "web"}
              />

              <TextField
                ref={passwordRef}
                label="Password"
                placeholder="••••••••"
                value={password}
                onChangeText={setPassword}
                maxLength={128}
                secureTextEntry
                autoComplete={isRegister ? "new-password" : "current-password"}
                textContentType={isRegister ? "newPassword" : "password"}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() =>
                  (isRegister ? confirmRef : ostrichIdRef).current?.focus()
                }
              />

              {isRegister ? null : (
                <View style={styles.idField}>
                  <TextField
                    ref={ostrichIdRef}
                    label="OstrichID"
                    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                    value={ostrichId}
                    onChangeText={setOstrichId}
                    maxLength={40}
                    autoCapitalize="characters"
                    autoComplete="off"
                    returnKeyType="go"
                    onSubmitEditing={submit}
                  />
                  <Text style={[styles.fieldHint, { color: colors.muted }]}>
                    Account created before OstrichIDs? Leave it empty once to
                    get yours.
                  </Text>
                </View>
              )}

              {isRegister ? (
                <TextField
                  ref={confirmRef}
                  label="Confirm password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  maxLength={128}
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  returnKeyType="go"
                  onSubmitEditing={submit}
                />
              ) : null}
            </View>

            {isRegister ? (
              <Text style={[styles.note, { color: colors.textSoft }]}>
                After you create the account, Ostrich gives you an OstrichID.
                You will need it to log in, and it is shown only once.
              </Text>
            ) : null}

            {shownError ? (
              <Text style={[styles.error, { color: colors.danger }]}>
                {shownError}
              </Text>
            ) : null}

            <Button
              title={isRegister ? "Create account" : "Log in"}
              loading={loading}
              onPress={submit}
              style={styles.submit}
            />

            <Button
              title={isRegister ? "I have an account" : "Create account"}
              variant="secondary"
              disabled={loading}
              onPress={() =>
                router.replace(isRegister ? "/login" : "/register")
              }
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: radius.card,
    padding: 24,
  },

  eyebrow: {
    fontSize: 14,
    marginBottom: 4,
  },

  title: {
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 22,
  },

  fields: {
    gap: 18,
  },

  idField: {
    gap: 8,
  },

  fieldHint: {
    fontSize: 13,
    lineHeight: 18,
  },

  note: {
    marginTop: 18,
    fontSize: 14,
    lineHeight: 20,
  },

  error: {
    marginTop: 16,
    fontSize: 14,
    lineHeight: 20,
  },

  submit: {
    marginTop: 24,
    marginBottom: 12,
  },
});
