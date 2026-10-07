# Ostrich CLI

The terminal client: the same chats, end-to-end encryption and settings as
the apps, laid out like the web app (chats on the left, the chat on the
right; one at a time in a narrow terminal). Works with the keyboard and the
mouse.

## Install

Linux and macOS:

```bash
curl -fsSL https://github.com/Skerpsh/Ostrich_Messenger/releases/latest/download/install.sh | sh
```

It downloads the build for your system from the latest release, checks its
SHA-256 and puts it in `~/.local/bin/ostrich`. Windows: download
`ostrich-windows-amd64.exe` from the
[latest release](https://github.com/Skerpsh/Ostrich_Messenger/releases/latest)
(SmartScreen asks once: *More info* → *Run anyway*).

`ostrich --version` shows the version; at start the CLI says when a newer
release is out (`OSTRICH_NO_UPDATE_CHECK=1` turns that off).

From the source: `cd cli && go build -o ostrich . && ./ostrich`.

## Releasing

```bash
git tag v1.2.0 && git push origin v1.2.0
```

The *Release CLI* workflow tests and builds the CLI for Linux, macOS and
Windows (x86 and ARM) and publishes the files, `install.sh` and
`SHA256SUMS` as the release, with notes from the commits since the last
tag.

`OSTRICH_SERVER=http://localhost:3000 ./ostrich` uses another backend.

Preferences (theme, accent color, bell) and the contacts' keys seen so far
are kept in `~/.config/ostrich/`.

## Remember me

With "Remember me on this computer" checked on the login screen (on by
default, `Ctrl+R` toggles it), the CLI starts logged in next time, like the
web app. The session token and the account's private key go to the system
keyring (GNOME Keyring / KWallet, the macOS Keychain, the Windows Credential
Manager); without one, e.g. on a server over SSH, to
`~/.config/ostrich/session-*.json`, readable only by you.

A remembered session stays when the CLI is closed. It ends, and is
forgotten here, with Settings → Log out, Log out of all devices, deleting
the account, logging this device out from another one, or after 30 days
unused. Uncheck "Remember me" on a computer you share: then closing the CLI
logs out.

## Keys

| Where | Keys |
|---|---|
| Everywhere | `Ctrl+C` quit |
| Login | `Tab` log in / create account, `↑↓` field, `Ctrl+R` remember me, `Enter` next / submit |
| Chats list | `↑↓` move, `Enter` open, `/` search, `n` new chat (type a @username), `m` chat menu (pin, mute, clear, delete), `s` settings, `t` light / dark, `Tab` to the chat, `q` quit |
| Chat | `Enter` send, `Alt+Enter` new line, `↑` (empty input) choose a message, `Ctrl+O` chat menu, `Ctrl+F` search, `Ctrl+K` safety code, `PgUp/PgDn` scroll, `Tab` to the list, `Esc` back |
| Chosen message | `Enter` menu, `r` reply, `e` edit, `d` delete, `c` copy, `1`–`8` react, `Esc` back |
| Menus | `↑↓` choose, `Enter` select (destructive actions ask twice), `1`–`8` react, `Esc` close |
| Settings | `↑↓` move, `Enter` open / toggle, `←→` theme and accent, `Esc` close |

Mouse: click a chat to open it, right-click it (or a message) for its menu,
scroll the wheel over the messages; the header buttons, settings rows, theme
and accent choices are clickable too.

## Safety code

`Ctrl+K` (or 🛡 in the chat header) shows 40 digits that are the same on
both sides of a chat. Compare them with your contact: if they match, the
server has not swapped your keys. When a contact's key changes, the chat
warns and holds back sending until the codes are confirmed (`y`).
