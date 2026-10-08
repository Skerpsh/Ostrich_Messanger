// First: crypto.getRandomValues for the apps.
import "@/lib/crypto-polyfill";
import { useEffect } from "react";
import {
  DarkTheme,
  DefaultTheme,
  SplashScreen,
  Stack,
  ThemeProvider,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { Platform } from "react-native";
import { AuthProvider, useAuth } from "@/context/auth";
import { ChatsProvider } from "@/context/chats";
import { OutboxProvider } from "@/context/outbox";
import { RealtimeProvider } from "@/context/realtime";
import { AppThemeProvider, useAppTheme } from "@/context/theme";
import { rememberLink } from "@/lib/links";

// Keep the splash screen until the saved session has been checked.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <AuthProvider>
        <RealtimeProvider>
          <ChatsProvider>
            <OutboxProvider>
              <RootNavigator />
            </OutboxProvider>
          </ChatsProvider>
        </RealtimeProvider>
      </AuthProvider>
    </AppThemeProvider>
  );
}

function RootNavigator() {
  const { state } = useAuth();
  const { mode, colors } = useAppTheme();

  useEffect(() => {
    if (state.status !== "loading") {
      SplashScreen.hideAsync();
    }
  }, [state.status]);

  // Paint the page behind the app so Safari's toolbars and overscroll areas
  // follow the theme instead of showing a white body.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.bg);

    if (Platform.OS === "web") {
      document.documentElement.style.backgroundColor = colors.bg;
      document.documentElement.style.colorScheme = mode;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", colors.surface);
    }
  }, [mode, colors.bg, colors.surface]);

  // Web: an invite or profile link opened while logged out is opened
  // after logging in (components/chat-list.tsx).
  useEffect(() => {
    if (
      Platform.OS === "web" &&
      state.status === "signedOut" &&
      /^\/chats\/(join|u)\/[^/]+$/.test(location.pathname)
    ) {
      rememberLink(location.pathname);
    }
  }, [state.status]);

  if (state.status === "loading") {
    return null;
  }

  const signedIn = state.status === "signedIn";
  // A new OstrichID must be saved before anything else.
  const mustSaveOstrichId = signedIn && state.pendingOstrichId !== null;
  // A device without the account's keys must unlock them first.
  const mustUnlock = signedIn && !mustSaveOstrichId && state.privateKey === null;
  const baseTheme = mode === "dark" ? DarkTheme : DefaultTheme;

  return (
    <ThemeProvider
      value={{
        ...baseTheme,
        colors: {
          ...baseTheme.colors,
          background: colors.bg,
          card: colors.surface,
          text: colors.text,
          border: colors.line,
          primary: colors.accent,
        },
      }}
    >
      <StatusBar style={mode === "dark" ? "light" : "dark"} />

      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="index" />
          <Stack.Screen name="login" />
          <Stack.Screen name="register" />
        </Stack.Protected>

        <Stack.Protected guard={mustSaveOstrichId}>
          <Stack.Screen name="ostrich-id" />
        </Stack.Protected>

        <Stack.Protected guard={mustUnlock}>
          <Stack.Screen name="unlock" />
        </Stack.Protected>

        <Stack.Protected guard={signedIn && !mustSaveOstrichId && !mustUnlock}>
          <Stack.Screen name="chats" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
