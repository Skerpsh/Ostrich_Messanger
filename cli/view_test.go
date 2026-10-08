package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	zone "github.com/lrstanley/bubblezone"
)

// A signed-in model with chats and messages, encrypted like real ones
// (keys from the shared test vectors): B is the user, A writes to them.
func testModel(t *testing.T, w, h int, mode string) model {
	t.Helper()
	zone.NewGlobal()

	// Preferences and known keys go to a temporary directory.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	v, privateA, privateB := loadVectors(t)
	m := newModel(true, nil)
	m.cfg.Theme = mode
	m.applyTheme()
	m.width, m.height = w, h

	me := "22222222-2222-4222-8222-222222222222"
	m.user = &LoginResponse{Token: "t", PrivateKey: privateB, User: Account{
		ID: me, Username: "bob", IsDeveloper: true, ShowPresence: true, ReadReceipts: true,
	}}
	m.stage = stageMain
	m.knownKeys = map[string]string{}
	m.keyChanged = map[string]bool{}
	m.list = newListState(m.pal)

	now := time.Now().UTC()
	at := func(minutes int) string {
		return now.Add(time.Duration(minutes) * time.Minute).Format(time.RFC3339Nano)
	}

	encrypt := func(text, id, sender string, private []byte, peer string) string {
		content, err := encryptMessage(text, id, sender, private, peer, v.ChatID)
		if err != nil {
			t.Fatal(err)
		}

		return content
	}

	var messages []Message

	for i, text := range []string{
		"Hi! How are you?",
		"Great, thanks. A longer message that has to wrap over several lines in the bubble, to see how wrapping looks in a narrow terminal.",
		"👍",
	} {
		id := newMessageID()
		sender, private, peer := v.SenderID, privateA, v.PublicKeyB

		if i == 1 {
			sender, private, peer = me, privateB, v.PublicKeyA
		}

		messages = append(messages, Message{
			ID: id, ChatID: v.ChatID, SenderID: sender, SenderUsername: "alice",
			Content:   encrypt(text, id, sender, private, peer),
			CreatedAt: at(-60 + i*2),
		})
	}

	messages[1].ReplyTo = &ReplyPreview{ID: messages[0].ID, SenderID: v.SenderID, SenderUsername: "alice", Content: messages[0].Content}
	messages[1].Reactions = []Reaction{{Emoji: "❤️", UserID: v.SenderID}}
	edited := at(-1)
	messages[1].EditedAt = &edited
	messages = append(messages, Message{ID: newMessageID(), ChatID: v.ChatID, SenderID: v.SenderID, Content: "plain text from the server", CreatedAt: at(-1)})

	// Formatting, a forwarded message, files.
	for _, text := range []string{
		"**bold** and _italic_, `code` and a link https://example.org/page, ~~gone~~",
		encodePayload(payload{text: "forwarded text", forwardedFrom: "carol"}),
		encodePayload(payload{text: "", attachments: []attachment{
			{ID: newMessageID(), Key: "a2V5", Name: "holiday photo with a long name.jpg", Mime: "image/jpeg", Size: 1234567},
			{ID: newMessageID(), Key: "a2V5", Name: "report.pdf", Mime: "application/pdf", Size: 34567},
		}}),
	} {
		id := newMessageID()
		messages = append(messages, Message{ID: id, ChatID: v.ChatID, SenderID: v.SenderID,
			Content: encrypt(text, id, v.SenderID, privateA, v.PublicKeyB), CreatedAt: at(0)})
	}

	last := messages[len(messages)-1]
	m.chats = []Chat{
		{ID: v.ChatID, UserID: v.SenderID, Username: "alice", PublicKey: v.PublicKeyA, Pinned: true, UnreadCount: 3,
			LastMessage:    &LastMessage{ID: last.ID, SenderID: last.SenderID, Content: last.Content, CreatedAt: last.CreatedAt},
			PeerLastReadAt: &edited, Created: at(-100)},
		{ID: newMessageID(), UserID: newMessageID(), Username: "carol", Muted: true, IsDeveloper: true, Created: at(-3000)},
	}
	m.chats[0].PinnedMessage = &LastMessage{ID: messages[0].ID, SenderID: messages[0].SenderID, Content: messages[0].Content, CreatedAt: messages[0].CreatedAt}
	m.chatsLoaded = true
	m.drafts = map[string]string{m.chats[1].ID: "half-written"}
	m.presence[v.SenderID] = presence{online: true}

	m.chat = newChatState(v.ChatID, m.pal, m.paneWidth())
	m.chat.messages = messages
	m.chat.loaded = true
	m.chat.unreadAfter = &messages[1].CreatedAt
	m.focus = paneChat
	m.layoutInputs()

	// One message on its way, one refused.
	_ = m.queueMessage(v.ChatID, newMessageID(), encrypt("on its way", "x", me, privateB, v.PublicKeyA), nil, nil)
	_ = m.queueMessage(v.ChatID, newMessageID(), "e2:AAAA", nil, nil)
	m.outgoing[1].state, m.outgoing[1].err = "failed", "Something went wrong"

	return m
}

// checkView: exactly h lines of exactly w cells.
func checkView(t *testing.T, name string, view string, w, h int) {
	t.Helper()
	lines := strings.Split(view, "\n")

	if len(lines) != h {
		t.Errorf("%s: %d lines, want %d", name, len(lines), h)
	}

	for i, line := range lines {
		if got := ansi.StringWidth(line); got != w {
			t.Errorf("%s: line %d is %d cells, want %d: %q", name, i, got, w, ansi.Strip(line))
		}
	}
}

func TestViews(t *testing.T) {
	for _, size := range [][2]int{{140, 40}, {100, 30}, {80, 24}, {50, 20}} {
		for _, mode := range []string{"dark", "light"} {
			w, h := size[0], size[1]
			name := fmt.Sprintf("%dx%d %s", w, h, mode)
			m := testModel(t, w, h, mode)

			checkView(t, name+" chat", m.View(), w, h)

			m.chat.selecting, m.chat.selectedID = true, m.chat.messages[1].ID
			m.openMenu(m.messageMenu(m.chats[0], m.chat.messages[1]))
			checkView(t, name+" message menu", m.View(), w, h)
			m.menu = nil

			m.openMenu(m.chatMenu(m.chats[0], true))
			checkView(t, name+" chat menu", m.View(), w, h)
			m.menu = nil

			m.keyChanged[m.chats[0].UserID] = true
			m.safetyOpen = true
			checkView(t, name+" safety code", m.View(), w, h)
			m.safetyOpen = false

			m.chat.replyTo = &m.chat.messages[0]
			m.chat.err = "Something went wrong"
			_ = m.openChatSearch()
			m.chat.search.SetValue("thanks")
			checkView(t, name+" banners and search", m.View(), w, h)

			m.chats[0].Blocked, m.chats[0].BlockedByMe = true, true
			checkView(t, name+" blocked", m.View(), w, h)

			m.focus = paneList
			_ = m.startSearch("@dave")
			checkView(t, name+" list search", m.View(), w, h)
			m.stopSearch()

			_ = m.openSettings()
			m.settings.sessionsLoaded = true
			m.settings.sessions = []Session{{ID: "s1", Current: true, CreatedAt: m.chats[0].Created, LastUsedAt: m.chats[0].Created}}
			checkView(t, name+" settings", m.View(), w, h)
			_ = m.openForm("password")
			checkView(t, name+" settings form", m.View(), w, h)

			m.closeSettings()
			m.chat = nil
			checkView(t, name+" no chat", m.View(), w, h)

			m.stage = stageAuth
			m.auth.err = "Invalid username, password or OstrichID"
			checkView(t, name+" login", m.View(), w, h)
			m.auth.setMode(true)
			checkView(t, name+" register", m.View(), w, h)

			m.stage = stageOstrichID
			m.user.OstrichID = "K7QM-3XRA-9TPW-H2DC-M8VN"
			checkView(t, name+" OstrichID", m.View(), w, h)
		}
	}
}

// key sends keys to the model (commands are not run: no network).
func press(m model, keys ...string) model {
	for _, k := range keys {
		var msg tea.KeyMsg

		switch k {
		case "up":
			msg = tea.KeyMsg{Type: tea.KeyUp}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case "left":
			msg = tea.KeyMsg{Type: tea.KeyLeft}
		case "right":
			msg = tea.KeyMsg{Type: tea.KeyRight}
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "tab":
			msg = tea.KeyMsg{Type: tea.KeyTab}
		case "pgup":
			msg = tea.KeyMsg{Type: tea.KeyPgUp}
		case "ctrl+f":
			msg = tea.KeyMsg{Type: tea.KeyCtrlF}
		case "ctrl+o":
			msg = tea.KeyMsg{Type: tea.KeyCtrlO}
		case "ctrl+k":
			msg = tea.KeyMsg{Type: tea.KeyCtrlK}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		}

		next, _ := m.Update(msg)
		m = next.(model)
		_ = m.View()
	}

	return m
}

func TestKeys(t *testing.T) {
	for _, size := range [][2]int{{120, 34}, {60, 24}} {
		m := testModel(t, size[0], size[1], "dark")
		check := func(ok bool, what string) {
			t.Helper()

			if !ok {
				t.Fatalf("%v: %s", size, what)
			}
		}

		// ↑ in the empty composer chooses messages; the menu replies.
		// ↑ until the oldest, then ↓ to the second.
		m = press(m, "up")

		for i := 0; i < 20; i++ {
			m = press(m, "up")
		}

		m = press(m, "down")
		check(m.chat.selecting && m.chat.selectedID == m.chat.messages[1].ID, "message 1 selected")
		m = press(m, "enter")
		check(m.menu != nil, "message menu open")
		m = press(m, "enter")
		check(m.menu == nil && m.chat.replyTo != nil && !m.chat.selecting, "reply started")
		m = press(m, "esc")
		check(m.chat.replyTo == nil, "reply cancelled")

		// e edits an own message (1 is own).
		m = press(m, "up")

		for m.chat.selectedID != m.chat.messages[1].ID {
			m = press(m, "up")
		}

		m = press(m, "e")
		check(m.chat.editing != nil && m.chat.composer.Value() != "", "editing")
		m = press(m, "esc")
		check(m.chat.editing == nil && m.chat.composer.Value() == "", "edit cancelled")

		// Typing; the chat menu; search; safety code.
		m = press(m, "h", "i")
		check(m.chat.composer.Value() == "hi", "typed")
		m = press(m, "ctrl+o", "down", "down")
		check(m.menu != nil, "chat menu open")
		m = press(m, "esc", "ctrl+f", "t", "h", "a")
		check(m.chat.searching && m.chat.highlight != "", "search finds a message")
		m = press(m, "esc", "ctrl+k")
		check(m.safetyOpen, "safety code shown")
		m = press(m, "esc", "pgup")
		check(!m.safetyOpen, "safety code closed")

		// The list: search and the chat menu.
		m.focus = paneList
		m = press(m, "/", "c", "a", "r")
		rows := m.listRows()
		check(len(rows) == 2 && rows[0].username == "car" && rows[1].chat.Username == "carol", "search filters and offers @car")
		m = press(m, "esc", "m")
		check(m.menu != nil, "list menu open")
		m = press(m, "esc", "t")
		check(m.pal.mode == themeLight, "theme toggled")
		m = press(m, "t", "s")
		check(m.settings != nil && m.focus == paneSettings, "settings open")

		// Settings: theme, accent, a form; then every row.
		m = press(m, "down", "down", "down", "right")
		m = press(m, "down", "right")
		check(m.cfg.Accent != defaultAccent, "accent changed")
		m = press(m, "down", "enter")
		check(m.settings.form != "", "form open")
		m = press(m, "x", "tab", "esc")
		check(m.settings.form == "", "form closed")

		for i := 0; i < 30; i++ {
			m = press(m, "down")
		}

		m = press(m, "esc")
		check(m.settings == nil, "settings closed")
	}
}

// click renders the model and clicks the middle of a zone.
func click(t *testing.T, m model, id string, button tea.MouseButton) model {
	t.Helper()

	// The zone manager is shared by the tests: forget where the zone was
	// drawn before, so the position found is this view's.
	zone.Clear(id)
	_ = m.View()

	var z *zone.ZoneInfo

	// Zones are recorded in the background.
	for i := 0; i < 100; i++ {
		if z = zone.Get(id); z != nil && !z.IsZero() {
			break
		}

		time.Sleep(5 * time.Millisecond)
	}

	if z == nil || z.IsZero() {
		t.Fatalf("zone %s not drawn", id)
	}

	// The rest of the view's zones are recorded right after.
	time.Sleep(5 * time.Millisecond)

	next, _ := m.Update(tea.MouseMsg{
		X: (z.StartX + z.EndX) / 2, Y: (z.StartY + z.EndY) / 2,
		Button: button, Action: tea.MouseActionPress,
	})

	return next.(model)
}

func TestMouse(t *testing.T) {
	m := testModel(t, 120, 34, "dark")
	chatID := m.chat.id

	// The header's menu button, then a click outside closes it.
	m = click(t, m, "chat:menu", tea.MouseButtonLeft)

	if m.menu == nil {
		t.Fatal("chat menu not opened")
	}

	m = click(t, m, "list:search", tea.MouseButtonLeft)

	if m.menu != nil {
		t.Fatal("menu not closed by a click outside")
	}

	// Right click on a chat row: its menu.
	m = click(t, m, "list:row:1", tea.MouseButtonRight)

	if m.menu == nil || m.menu.title != "@carol" {
		t.Fatalf("row menu: %+v", m.menu)
	}

	m.menu = nil

	// Settings, an accent swatch, the theme buttons.
	m = click(t, m, "list:settings", tea.MouseButtonLeft)

	if m.settings == nil {
		t.Fatal("settings not opened")
	}

	m = click(t, m, "set:accent:4", tea.MouseButtonLeft)

	if m.cfg.Accent != "blue" {
		t.Fatalf("accent %s", m.cfg.Accent)
	}

	m = click(t, m, "set:theme:light", tea.MouseButtonLeft)

	if m.pal.mode != themeLight {
		t.Fatal("theme not light")
	}

	m = click(t, m, "set:close", tea.MouseButtonLeft)

	// Back in the chat: the safety code button.
	if m.settings != nil || m.chat == nil || m.chat.id != chatID {
		t.Fatal("settings not closed")
	}

	m = click(t, m, "chat:safety", tea.MouseButtonLeft)

	if !m.safetyOpen {
		t.Fatal("safety code not shown")
	}

	m = click(t, m, "safety:close", tea.MouseButtonLeft)

	// A message: clicking it opens its menu.
	m = click(t, m, "chat:messages", tea.MouseButtonRight)

	// The middle of the area may be between bubbles; either is fine, but
	// nothing may break.
	m.menu = nil

	// Login: the "Create account" tab.
	m.stage = stageAuth
	m = click(t, m, "auth:register", tea.MouseButtonLeft)

	if !m.auth.register {
		t.Fatal("register tab not selected")
	}
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b  string
		newer bool
	}{
		{"v1.2.4", "v1.2.3", true},
		{"v1.10.0", "v1.9.9", true},
		{"v2.0.0", "v1.99.99", true},
		{"v1.2.3", "v1.2.3", false},
		{"v1.2.2", "v1.2.3", false},
		{"v1.2.3", "dev", false},
		{"garbage", "v1.0.0", false},
	} {
		if got := newerVersion(c.a, c.b); got != c.newer {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestOutboxForwardDrafts(t *testing.T) {
	m := testModel(t, 120, 34, "dark")
	chat := m.chats[0]
	first := m.chat.messages[0]

	// Pending messages are shown after the history.
	shown := m.shown()

	if len(shown) != len(m.chat.messages)+2 || m.outgoingState(shown[len(shown)-1].ID) != "failed" {
		t.Fatalf("pending not shown: %d", len(shown))
	}

	// Their menu: send again, copy, delete.
	menu := m.messageMenu(chat, shown[len(shown)-1])

	if menu.reactionsFor != nil || menu.items[0].label[:10] != "Send again" {
		t.Fatalf("pending menu: %+v", menu.items)
	}

	m.openMenu(menu)
	_ = m.chooseItem(len(menu.items) - 1)

	if len(m.outgoing) != 1 {
		t.Fatalf("not dropped: %d", len(m.outgoing))
	}

	// A draft stays with its chat.
	m.chat.composer.SetValue("unsent words")
	m.closeChat()

	if m.drafts[chat.ID] != "unsent words" {
		t.Fatalf("draft %q", m.drafts[chat.ID])
	}

	_ = m.openChat(chat)

	if m.chat.composer.Value() != "unsent words" {
		t.Fatalf("draft not restored: %q", m.chat.composer.Value())
	}

	// Forwarding: the message goes to the outbox of the other chat, which
	// opens, encrypted for it with whom it comes from.
	target := m.chats[0]
	target.ID, target.Username = newMessageID(), "erin"
	m.chats = append(m.chats, target)
	m = run(m, m.forward(chat, first, target))

	last := m.outgoing[len(m.outgoing)-1].message

	if last.ChatID != target.ID || m.chat.id != target.ID {
		t.Fatalf("forward went to %s, open %s", last.ChatID, m.chat.id)
	}

	if got := m.show(target, last.ID, last.SenderID, last.Content); got.forwardedFrom != "alice" || got.text != "Hi! How are you?" {
		t.Fatalf("forwarded: %+v", got)
	}
}

func TestMarkupLines(t *testing.T) {
	p := newPalette(themeDark, defaultAccent)

	lines := markupLines("**bold** words that wrap around and a https://example.org/very/long/link", 20, p.text, p.bg, p.panelAlt, p.accent)

	for _, line := range lines {
		if w := ansi.StringWidth(line); w > 20 {
			t.Errorf("line of %d cells: %q", w, ansi.Strip(line))
		}
	}

	if got := ansi.Strip(strings.Join(lines, "\n")); !strings.Contains(got, "bold words") || strings.Contains(got, "**") {
		t.Errorf("text: %q", got)
	}
}

// run carries out a command's background work (no network involved) and
// applies its result.
func run(m model, cmd tea.Cmd) model {
	if cmd == nil {
		return m
	}

	switch msg := cmd().(type) {
	case resultMsg:
		next, _ := m.Update(msg)
		return next.(model)
	case tea.BatchMsg:
		for _, c := range msg {
			m = run(m, c)
		}
	}

	return m
}

func TestAttachmentFiles(t *testing.T) {
	dir := t.TempDir()

	// Names from other users cannot leave the folder or hide.
	for name, want := range map[string]string{
		"../../.bashrc":   "_.._.bashrc",
		"photo.jpg":       "photo.jpg",
		".hidden":         "hidden",
		"a/b\\c:d*e?.txt": "a_b_c_d_e_.txt",
		"\x1b[31mred":     "_[31mred",
		"":                "attachment",
	} {
		if got := safeFileName(name); got != want {
			t.Errorf("safeFileName(%q) = %q, want %q", name, got, want)
		}
	}

	// Saving never overwrites.
	a := attachment{Name: "notes.txt"}
	first, err := saveAttachment(dir, a, []byte("one"))
	if err != nil {
		t.Fatal(err)
	}

	second, err := saveAttachment(dir, a, []byte("two"))
	if err != nil || filepath.Base(second) != "notes (2).txt" {
		t.Fatalf("second file: %s %v", second, err)
	}

	if data, _ := os.ReadFile(first); string(data) != "one" {
		t.Fatalf("first file overwritten: %q", data)
	}

	// Picking: sizes and kinds.
	path := filepath.Join(dir, "pic.png")
	_ = os.WriteFile(path, []byte("\x89PNG\r\n\x1a\n...."), 0o600)

	if file, err := pickFile(" '" + path + "' "); err != nil || file.mime != "image/png" || file.name != "pic.png" {
		t.Fatalf("picked %+v %v", file, err)
	}

	if _, err := pickFile(dir); err == nil {
		t.Fatal("a folder was accepted")
	}

	if _, err := pickFile(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("a missing file was accepted")
	}

	if got := attachmentsLabel([]attachment{{Mime: "image/png"}, {Mime: "image/jpeg"}}); got != "🖼 2 photos" {
		t.Fatalf("label %q", got)
	}

	if got := formatSize(1234567); got != "1.2 MB" {
		t.Fatalf("size %q", got)
	}
}
