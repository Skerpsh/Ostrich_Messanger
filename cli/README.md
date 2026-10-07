# Ostrich CLI

The terminal client: the same chats, end-to-end encryption and settings as
the apps, laid out like the web app (chats on the left, the chat on the
right; one at a time in a narrow terminal). Works with the keyboard and the
mouse.

```bash
cd cli
go build -o ostrich .
./ostrich
```

`OSTRICH_SERVER=http://localhost:3000 ./ostrich` uses another backend.

Preferences (theme, accent color, bell) and the contacts' keys seen so far
are kept in `~/.config/ostrich/`.

## Keys

| Where | Keys |
|---|---|
| Everywhere | `Ctrl+C` quit |
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
