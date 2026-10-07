# Ostrich — web, iOS and Android client

Expo (SDK 57) + expo-router app. One codebase for Ostrich Web and the
mobile apps; styled after the Ostrich website.

## Features

- End-to-end encryption: messages are encrypted on the device (X25519 +
  XChaCha20-Poly1305) with keys derived from the OstrichID, which never leaves
  the device; the server stores only ciphertext. See `src/lib/crypto.ts`
- Log in with @username + password + OstrichID; a device logged in without
  keys unlocks them once with the OstrichID
- Phones: chats list and chat on separate screens. Wide screens (tablets,
  desktop browsers, Mac): chats list on the left, open chat on the right
- Chats list: last message, live unread counters, "typing…", search that can
  start a chat by exact @username; pin and mute chats; delete a chat (for
  both); long press / right click for the menu
- Chat: older history while scrolling up, grouped bubbles, day separators,
  "unread messages" line, read receipts, replies (swipe left on phones, hover
  or menu on desktop), edit and delete own messages, reactions, search,
  block / unblock
- Profile pictures, DEV badge, theme and accent color (per device)
- Settings: privacy (online status, read receipts), notifications (browser
  notifications on web, push in the apps), devices with per-device log out,
  username, password, delete account

## Structure

```
src/
  app/              screens (expo-router)
    _layout.tsx     providers, routes guarded by login state
    index.tsx       welcome screen
    login.tsx, register.tsx
    ostrich-id.tsx  new OstrichID, shown once until saved
    unlock.tsx      enter the OstrichID once on a device without keys
    chats/_layout.tsx  one or two columns depending on screen width
    chats/index.tsx    chats list (phones) / "select a chat" (wide)
    chats/[chatId].tsx chat
    chats/new.tsx      new chat
    chats/settings.tsx theme, username, password, log out everywhere
  components/       UI building blocks (button, text field, header, …)
  context/          auth session, chats list + unread counts, realtime, theme
  lib/              API client, websocket, storage, formatting
  theme/colors.ts   palette (monochrome + accent), wide-layout breakpoint
assets/images/      app icon, splash, favicon
```

## Running

```bash
npm install
npm start          # then press w (web), i (iOS), a (Android)
npm run typecheck
npm run build:web  # static web build in dist/
```

The app talks to `https://62.238.111.55.nip.io` by default. For a local
backend create `.env.local`:

```
EXPO_PUBLIC_API_URL=http://<your-computer-ip>:3000
```

(use your computer's LAN IP, not `localhost`, when testing on a phone).
