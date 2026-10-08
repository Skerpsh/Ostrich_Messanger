package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func TestMentionCompletionAndSending(t *testing.T) {
	m, group := withGroup(t, testModel(t, 140, 40, "dark"))
	m.focus = paneChat
	m.chat.composer.SetValue("hi @ca")

	if names := m.mentionSuggestions(group); len(names) != 1 || names[0] != "carol" {
		t.Fatalf("suggestions %v", names)
	}

	if !strings.Contains(ansi.Strip(m.View()), "Tab @carol") {
		t.Error("suggestion not shown")
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(model)

	if got := m.chat.composer.Value(); got != "hi @carol " {
		t.Fatalf("completed %q", got)
	}

	// The server is told whom it mentions (not the sender, not strangers).
	if ids := m.mentionsIn(group, "@carol and @bob and @nobody"); len(ids) != 1 || ids[0] != m.members[2].ID {
		t.Fatalf("mentions %v", ids)
	}

	if _, err := m.queueText(group, "@carol look", nil, nil); err != nil {
		t.Fatal(err)
	}

	if o := m.outgoing[len(m.outgoing)-1]; len(o.mentions) != 1 {
		t.Fatalf("outgoing mentions %v", o.mentions)
	}
}

func TestSavedAndBadges(t *testing.T) {
	m := testModel(t, 140, 40, "dark")
	own, _ := publicKeyOf(m.user.PrivateKey)
	saved := Chat{ID: newMessageID(), Type: "saved", PublicKey: own, Created: m.chats[0].Created}

	// Encrypted for oneself, readable again.
	content, err := m.encryptFor(saved, "a note", "n1")
	if err != nil {
		t.Fatal(err)
	}

	if text, status := m.decrypt(saved, "n1", m.user.User.ID, content); status != decryptOK || text != "a note" {
		t.Fatalf("saved: %q", text)
	}

	m.chats = append([]Chat{saved}, m.chats...)
	m.chats[1].UnreadMentions = 1
	m.chats[1].JoinRequests = 2
	list := ansi.Strip(m.listView(60, 40))

	for _, want := range []string{"🔖 Saved messages", " @ ", "+2"} {
		if !strings.Contains(list, want) {
			t.Errorf("%q missing:\n%s", want, list)
		}
	}

	m.chat = newChatState(saved.ID, m.pal, m.paneWidth())
	m.chat.loaded = true
	m.connStatus = connOnline

	if header := ansi.Strip(strings.Join(m.chatHeader(saved, 80), "\n")); !strings.Contains(header, "only you") {
		t.Errorf("header: %s", header)
	}
}

func TestLinksAndSearch(t *testing.T) {
	m := testModel(t, 140, 40, "dark")

	for text, want := range map[string][2]string{
		"https://web.example/chats/join/abcdefghijklmnopqrstuv": {"join", "abcdefghijklmnopqrstuv"},
		"http://x/chats/u/alice.b":                              {"user", "alice.b"},
		"hello":                                                 {"", ""},
	} {
		if kind, value := parseLink(text); kind != want[0] || value != want[1] {
			t.Errorf("%q: %s %s", text, kind, value)
		}
	}

	_ = m.startSearch("")
	m.list.search.SetValue("https://web.example/chats/join/abcdefghijklmnopqrstuv")

	if rows := m.listRows(); len(rows) != 1 || rows[0].linkKind != "join" {
		t.Fatalf("link row: %+v", rows)
	}

	if !strings.Contains(ansi.Strip(m.listView(60, 40)), "Open the group invite") {
		t.Error("link row not drawn")
	}

	// Messages of the open chat are found.
	m.list.search.SetValue("")
	m.list.matches = m.searchMessages("how are")

	if len(m.list.matches) != 1 || m.list.matches[0].text != "Hi! How are you?" {
		t.Fatalf("matches %+v", m.list.matches)
	}

	if !strings.Contains(ansi.Strip(m.listView(60, 40)), "Hi! How are you?") {
		t.Error("match not drawn")
	}
}

func TestQr(t *testing.T) {
	lines, err := qrLines(inviteLink("abcdefghijklmnopqrstuv"))
	if err != nil || len(lines) < 10 {
		t.Fatalf("%d lines, %v", len(lines), err)
	}

	m := testModel(t, 100, 40, "dark")
	m.qr = &qrState{title: "Invite", text: inviteLink("abcdefghijklmnopqrstuv")}
	checkView(t, "qr", m.View(), 100, 40)

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})

	if next.(model).qr != nil {
		t.Error("Esc did not close the QR code")
	}
}
