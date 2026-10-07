# Ostrich — web, iOS and Android client

Expo (SDK 57) + expo-router app. One codebase for Ostrich Web and the
mobile apps; styled after the Ostrich website.

## Features

- Log in with @username + password + OstrichID; create account (session is
  remembered: Keychain/Keystore on mobile, localStorage on web)
- OstrichID shown once after registration, until the user confirms saving it
- Phones: chats list and chat on separate screens. Wide screens (tablets,
  desktop browsers, Mac): chats list on the left, open chat on the right
- Chats list with last message, unread counters (live), search; start a
  chat by typing someone's exact @username into the search
- Chat: grouped bubbles, day separators, "unread messages" line, read
  receipts (✓ sent, ✓✓ read), multi-line composer (Enter sends on web)
- Replies: hover a message (web) or long-press it (any platform) → Reply;
  tapping a quote jumps to the original message
- Profile pictures: picked from the photo library, cropped square and
  resized on the device, re-encoded by the server
- DEV badge (gradient) next to developer accounts' names everywhere; given
  on the server with `npm run dev-badge:prod -- add @username`
- Settings: profile picture, theme (system / light / dark), accent color
  (stored per device), change username (once per 28 days), change
  password, log out of all devices
- Chat with live updates over WebSocket, automatic reconnect
- Light / dark theme (same switch as on the website)

## Structure

```
src/
  app/              screens (expo-router)
    _layout.tsx     providers, routes guarded by login state
    index.tsx       welcome screen
    login.tsx, register.tsx
    ostrich-id.tsx  new OstrichID, shown once until saved
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
