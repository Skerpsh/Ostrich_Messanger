import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

// Ostrich Web as an app: the service worker (public/sw.js) for opening
// without the network, and the browser's offer to install it.

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let installPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((listener) => listener());

if (Platform.OS === "web" && typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Shown from Settings instead of the browser's own banner.
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    changed();
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    changed();
  });
}

// Registers the service worker (production builds only: in development
// it would keep serving old code).
export function registerServiceWorker() {
  if (Platform.OS === "web" && process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

// Whether the browser offers to install the app now.
export function useCanInstall() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => installPrompt !== null,
    () => false,
  );
}

export async function installApp() {
  const prompt = installPrompt;

  if (!prompt) {
    return;
  }

  await prompt.prompt();
  await prompt.userChoice.catch(() => null);
  installPrompt = null;
  changed();
}
