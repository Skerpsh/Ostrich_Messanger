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
import { RealtimeProvider } from "@/context/realtime";
import { AppThemeProvider, useAppTheme } from "@/context/theme";

// Keep the splash screen until the saved session has been checked.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <AuthProvider>
        <RealtimeProvider>
          <RootNavigator />
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
        ?.setAttribute("content", colors.bg);
    }
  }, [mode, colors.bg]);

  if (state.status === "loading") {
    return null;
  }

  const signedIn = state.status === "signedIn";
  const baseTheme = mode === "dark" ? DarkTheme : DefaultTheme;

  return (
    <ThemeProvider
      value={{
        ...baseTheme,
        colors: {
          ...baseTheme.colors,
          background: colors.bg,
          card: colors.header,
          text: colors.text,
          border: colors.line,
          primary: colors.text,
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

        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="chats/index" />
          <Stack.Screen name="chats/[chatId]" />
          <Stack.Screen name="chats/new" options={{ presentation: "modal" }} />
          <Stack.Screen name="settings" options={{ presentation: "modal" }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
