# Ostrich — web, iOS and Android client

Expo (SDK 57) + expo-router app. One codebase for Ostrich Web and the
mobile apps; styled after the Ostrich website.

## Features

- Log in / create account (session is remembered: Keychain/Keystore on
  mobile, localStorage on web)
- Chats list with your login ID (tap to copy), pull to refresh
- New chat by the other user's login ID
- Chat with live updates over WebSocket, automatic reconnect
- Light / dark theme (same switch as on the website)

## Structure

```
src/
  app/              screens (expo-router)
    _layout.tsx     providers, routes guarded by login state
    index.tsx       welcome screen
    login.tsx, register.tsx
    chats/index.tsx chats list
    chats/new.tsx   new chat
    chats/[chatId].tsx chat
  components/       UI building blocks (button, text field, header, …)
  context/          auth session and theme
  lib/              API client, websocket, storage, formatting
  theme/colors.ts   website palette
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
