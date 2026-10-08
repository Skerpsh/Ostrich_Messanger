package main

import (
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// withGroup adds an open group to the test model: its key, members,
// a group event and messages from others and from the user.
func withGroup(t *testing.T, m model) (model, Chat) {
	t.Helper()

	v, _, _ := loadVectors(t)
	carolID := "7a1c3e5f-2b4d-4e6f-8a0b-1c2d3e4f5a6b"
	me := m.user.User.ID
	groupID := newMessageID()
	key := newGroupKey()
	m.addGroupKey(groupID, 2, key)

	now := time.Now().UTC()
	at := func(minutes int) string {
		return now.Add(time.Duration(minutes) * time.Minute).Format(time.RFC3339Nano)
	}

	message := func(sender, username, text string, minutes int) Message {
		id := newMessageID()

		return Message{ID: id, ChatID: groupID, SenderID: sender, SenderUsername: username,
			Content: encryptGroupMessage(text, id, sender, key, 2, groupID), CreatedAt: at(minutes)}
	}

	messages := []Message{
		{ID: newMessageID(), ChatID: groupID, SenderID: v.SenderID, SenderUsername: "alice", Kind: "system",
			Content: `{"type":"added","users":[{"id":"` + me + `","username":"bob"}]}`, CreatedAt: at(-10)},
		message(v.SenderID, "alice", "Welcome to the group!", -9),
		message(v.SenderID, "alice", "Second one", -9),
		message(me, "bob", "Thanks", -8),
		message(carolID, "carol", "Hello from carol", -7),
	}

	last := messages[len(messages)-1]
	group := Chat{
		ID: groupID, Type: "group", Role: "admin", MemberCount: 3, KeyEpoch: 2,
		EncryptedInfo: encryptGroupInfo(groupInfo{Name: "Ostrich team"}, key, 2, groupID),
		Created:       at(-20),
		LastMessage: &LastMessage{ID: last.ID, SenderID: last.SenderID, SenderUsername: "carol",
			Content: last.Content, CreatedAt: last.CreatedAt},
	}

	m.chats = append([]Chat{group}, m.chats...)
	m.chat = newChatState(groupID, m.pal, m.paneWidth())
	m.chat.messages = messages
	m.chat.loaded = true
	m.members = []groupMember{
		{foundUser: foundUser{ID: v.SenderID, Username: "alice", PublicKey: v.PublicKeyA}, Role: "owner"},
		{foundUser: foundUser{ID: me, Username: "bob"}, Role: "admin"},
		{foundUser: foundUser{ID: carolID, Username: "carol", PublicKey: v.PublicKeyB}, Role: "member"},
	}
	m.connStatus = connOnline
	m.presence[carolID] = presence{online: true}
	m.typingUntil[groupID+"|"+v.SenderID] = time.Now().Add(time.Minute)
	m.layoutInputs()

	return m, group
}

func TestGroupViews(t *testing.T) {
	for _, size := range [][2]int{{140, 40}, {80, 24}} {
		m, group := withGroup(t, testModel(t, size[0], size[1], "dark"))
		view := m.View()
		checkView(t, "group", view, size[0], size[1])
		plain := ansi.Strip(view)

		for _, want := range []string{"Ostrich team", "@alice is typing…", "@alice added you", "Welcome to the group!", "Hello from carol", "@carol"} {
			// A small terminal shows only the newest messages.
			if size[0] == 140 && !strings.Contains(plain, want) {
				t.Errorf("%dx%d: %q not shown:\n%s", size[0], size[1], want, plain)
			}
		}

		// The sender's name shows once over their bubbles in a row.
		if n := strings.Count(plain, "@alice\n"); strings.Count(plain, "Second one") == 1 && n > 1 {
			t.Errorf("sender shown %d times", n)
		}

		delete(m.typingUntil, group.ID+"|"+m.members[0].ID)

		if got := ansi.Strip(strings.Join(m.chatHeader(group, 60), "\n")); !strings.Contains(got, "3 members, 2 online") {
			t.Errorf("header: %s", got)
		}

		// The group's info, a member's menu, the prompt.
		_ = m.openGroupInfo(group)
		checkView(t, "info", m.View(), size[0], size[1])
		info := ansi.Strip(m.View())

		for _, want := range []string{"Add a member…", "Rename…", "@alice · owner", "@bob · admin (you)", "Leave group"} {
			if !strings.Contains(info, want) {
				t.Errorf("info: %q missing:\n%s", want, info)
			}
		}

		if strings.Contains(info, "Delete group") {
			t.Error("an admin may not delete the group")
		}

		m.menu = m.memberMenu(group, m.members[2])
		member := ansi.Strip(m.View())

		if !strings.Contains(member, "Remove from the group") || strings.Contains(member, "Make admin") {
			t.Errorf("member menu:\n%s", member)
		}

		m.menu = nil
		_ = m.newGroup()
		checkView(t, "prompt", m.View(), size[0], size[1])

		if !strings.Contains(ansi.Strip(m.View()), "New group") {
			t.Error("no prompt")
		}

		next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})

		if next.(model).prompt != nil {
			t.Error("Esc did not close the prompt")
		}
	}
}

func TestGroupSendAndList(t *testing.T) {
	m, group := withGroup(t, testModel(t, 140, 40, "light"))

	// Sent with the group's current key, readable by the members.
	cmd, err := m.queueText(group, "to everyone", nil, nil)
	if err != nil || cmd == nil {
		t.Fatal(err)
	}

	sent := m.outgoing[len(m.outgoing)-1].message

	if epoch, ok := groupMessageEpoch(sent.Content); !ok || epoch != 2 {
		t.Fatalf("epoch %d", epoch)
	}

	if shown := m.show(group, sent.ID, sent.SenderID, sent.Content); shown.text != "to everyone" {
		t.Fatalf("shown %q", shown.text)
	}

	// Without the key nothing is sent.
	delete(m.groupKeys, group.ID)

	if _, err := m.queueText(group, "x", nil, nil); err == nil {
		t.Fatal("sent without the group's key")
	}

	if m.chatName(group) != "Group" {
		t.Fatalf("name without the key: %q", m.chatName(group))
	}

	// The list shows who wrote the last message.
	m.groupKeys[group.ID] = map[int][]byte{}
	m2, group2 := withGroup(t, testModel(t, 140, 40, "dark"))
	m2.typingUntil = map[string]time.Time{}
	_ = group2
	list := ansi.Strip(m2.listView(50, 40))

	if !strings.Contains(list, "@carol: Hello from carol") || !strings.Contains(list, "Ostrich team") {
		t.Fatalf("list:\n%s", list)
	}
}

func TestSystemText(t *testing.T) {
	me := "me"

	for content, want := range map[string]string{
		`{"type":"created"}`: "@ann created the group",
		`{"type":"removed","users":[{"id":"x","username":"bob"}]}`:         "@ann removed @bob",
		`{"type":"role","user":{"id":"me","username"},"role":"x"}`:         "Group changed",
		`{"type":"role","user":{"id":"me","username":"b"},"role":"admin"}`: "@ann made you an admin",
		`{"type":"owner","user":{"id":"me","username":"b"}}`:               "You are now the owner",
		`not json`: "Group changed",
	} {
		if got := systemText("a", "ann", content, me); got != want {
			t.Errorf("%s: %q, want %q", content, got, want)
		}
	}
}
