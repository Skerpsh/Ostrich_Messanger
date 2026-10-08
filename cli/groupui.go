package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	zone "github.com/lrstanley/bubblezone"
)

// The groups' screens: the group's menu and info (members and what can be
// done with them, as menus), a one-line prompt for names, and creating a
// group.

// --- texts ---

func (m model) sayHi(chat Chat) string {
	if chat.Type == "group" {
		return "Say hi to the group!"
	}

	if chat.Type == "saved" {
		return "Notes, links and files: end-to-end encrypted, on all your devices"
	}

	return "Say hi to @" + sanitize(chat.Username) + "!"
}

// membersText: "5 members, 2 online".
func (m model) membersText(chat Chat) string {
	text := fmt.Sprintf("%d members", chat.MemberCount)
	online := 0

	if m.connStatus == connOnline {
		for _, member := range m.members {
			if member.ID != m.user.User.ID && m.presence[member.ID].online {
				online++
			}
		}
	}

	if online > 0 {
		text += fmt.Sprintf(", %d online", online)
	}

	return text
}

// typingText: "typing…", in a group who.
func (m model) typingText(chat Chat) string {
	users := m.typingIn(chat.ID)

	if chat.Type != "group" || len(users) == 0 {
		return "typing…"
	}

	if len(users) > 1 {
		return fmt.Sprintf("%d people are typing…", len(users))
	}

	return "@" + sanitize(m.memberName(users[0], "someone")) + " is typing…"
}

// --- prompt ---

// promptState is a one-line question over the screen.
type promptState struct {
	title  string
	hint   string
	input  textinput.Model
	submit func(m *model, value string) tea.Cmd
}

func (m *model) openPrompt(title, placeholder, hint, value string, limit int, submit func(m *model, value string) tea.Cmd) tea.Cmd {
	input := newInput(placeholder, limit, false, m.pal)
	input.Width = max(min(56, m.width-4)-8, 8)
	input.SetValue(value)
	input.CursorEnd()

	m.prompt = &promptState{title: title, hint: hint, input: input, submit: submit}

	if m.chat != nil {
		m.chat.composer.Blur()
	}

	return m.prompt.input.Focus()
}

func (m *model) closePrompt() tea.Cmd {
	m.prompt = nil

	if m.chat != nil && m.focus == paneChat {
		return m.chat.composer.Focus()
	}

	return nil
}

func (m *model) updatePromptKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "esc":
		return m.closePrompt()
	case "enter":
		prompt := m.prompt
		value := strings.TrimSpace(prompt.input.Value())

		if value == "" {
			return nil
		}

		cmd := m.closePrompt()

		return tea.Batch(cmd, prompt.submit(m, value))
	}

	var cmd tea.Cmd
	m.prompt.input, cmd = m.prompt.input.Update(msg)

	return cmd
}

func (m *model) updatePromptMouse(msg tea.MouseMsg) tea.Cmd {
	if msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft && !zone.Get("prompt").InBounds(msg) {
		return m.closePrompt()
	}

	return nil
}

func (m model) promptView() string {
	p := m.pal
	bg := p.panel
	w := min(56, m.width-4)
	inner := w - 4
	prompt := m.prompt

	lines := []string{
		bold(clip(prompt.title, inner), p.text, bg),
		"",
		seg("▌", p.accent, p.panelAlt) + fitLine(onBackground(prompt.input.View(), p.panelAlt), inner-1, p.panelAlt),
		"",
	}

	if prompt.hint != "" {
		for _, line := range wrap(prompt.hint, inner) {
			lines = append(lines, seg(line, p.muted, bg))
		}

		lines = append(lines, "")
	}

	lines = append(lines, seg(clip("Enter OK  Esc Cancel", inner), p.muted, bg))

	return zone.Mark("prompt", m.card(lines, w))
}

// --- creating a group ---

// newGroup asks for the group's name, then its members.
func (m *model) newGroup() tea.Cmd {
	return m.openPrompt("New group", "Name", "", "", 64, func(m *model, name string) tea.Cmd {
		return m.openPrompt("Members of "+name, "@alice @bob",
			fmt.Sprintf("Their exact @usernames, up to %d. The group's name and messages are end-to-end encrypted.", maxGroupMembers-1),
			"", 1200, func(m *model, value string) tea.Cmd {
				return m.createGroup(name, value)
			})
	})
}

func (m *model) createGroup(name, usernames string) tea.Cmd {
	var wanted []string

	for _, field := range strings.FieldsFunc(usernames, func(r rune) bool { return r == ' ' || r == ',' }) {
		username := cleanUsername(field)

		if username != "" && !strings.EqualFold(username, m.user.User.Username) {
			wanted = append(wanted, username)
		}
	}

	if len(wanted) == 0 {
		return m.showToast("Add at least one member", true)
	}

	if len(wanted) >= maxGroupMembers {
		return m.showToast(fmt.Sprintf("A group can have up to %d members", maxGroupMembers), true)
	}

	token := m.user.Token
	privateKey := m.user.PrivateKey
	own, _ := publicKeyOf(privateKey)
	me := foundUser{ID: m.user.User.ID, Username: m.user.User.Username, PublicKey: own}

	return task(func() func(*model) tea.Cmd {
		var members []foundUser
		seen := map[string]bool{}
		var err error

		for _, username := range wanted {
			var user foundUser

			if user, err = findUser(token, username); err != nil {
				err = fmt.Errorf("@%s: %w", username, err)
				break
			}

			if !seen[user.ID] {
				seen[user.ID] = true
				members = append(members, user)
			}
		}

		var id string
		var key []byte
		var chats []Chat

		if err == nil {
			id, key, err = createGroup(token, me, privateKey, name, members)
		}

		if err == nil {
			chats, err = getChats(token)
		}

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				return m.fail(err)
			}

			m.addGroupKey(id, 1, key)
			m.setChats(chats)

			if chat, ok := m.chatByID(id); ok {
				return m.openChat(chat)
			}

			return nil
		}
	})
}

// --- Saved messages ---

// openSaved opens the user's Saved messages (made the first time).
func (m *model) openSaved() tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		id, err := openSavedChat(token)

		var chats []Chat

		if err == nil {
			chats, err = getChats(token)
		}

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				return m.fail(err)
			}

			m.setChats(chats)

			if chat, ok := m.chatByID(id); ok {
				return m.openChat(chat)
			}

			return nil
		}
	})
}

func (m *model) savedMenu(chat Chat, inChat bool) *menuState {
	var items []menuItem

	if inChat {
		items = append(items, menuItem{icon: "🔍", label: "Search in chat", action: func(m *model) tea.Cmd {
			return m.openChatSearch()
		}})
	}

	pinLabel := "Pin to top"

	if chat.Pinned {
		pinLabel = "Unpin"
	}

	items = append(items,
		menuItem{icon: "📌", label: pinLabel, action: func(m *model) tea.Cmd { return m.setPinned(chat, !chat.Pinned) }},
		menuItem{icon: "🗑", label: "Delete Saved messages", danger: true, confirm: "Delete all saved messages?",
			action: func(m *model) tea.Cmd { return m.removeChat(chat, "everyone") }},
	)

	return &menuState{title: savedTitle, items: items, confirming: -1}
}

// --- the group's menu and info ---

// groupMenu: a group's actions (from the list or the chat).
func (m *model) groupMenu(chat Chat, inChat bool) *menuState {
	items := []menuItem{
		{icon: "👥", label: "Group info", action: func(m *model) tea.Cmd { return m.openGroupInfo(chat) }},
	}

	if inChat {
		items = append(items, menuItem{icon: "🔍", label: "Search in chat", action: func(m *model) tea.Cmd {
			return m.openChatSearch()
		}})

		if chat.PinnedMessage != nil && chat.isAdmin() {
			items = append(items, menuItem{icon: "📌", label: "Unpin message", action: func(m *model) tea.Cmd {
				return m.pinMessage(chat, "")
			}})
		}
	}

	pinLabel, muteLabel := "Pin to top", "Mute"

	if chat.Pinned {
		pinLabel = "Unpin"
	}

	if chat.Muted {
		muteLabel = "Unmute"
	}

	items = append(items,
		menuItem{icon: "📌", label: pinLabel, action: func(m *model) tea.Cmd { return m.setPinned(chat, !chat.Pinned) }},
		menuItem{icon: "🔕", label: muteLabel, action: func(m *model) tea.Cmd { return m.setMuted(chat, !chat.Muted) }},
		menuItem{icon: "◌", label: "Clear history for me", danger: true,
			confirm: "Clear? The others keep the messages",
			action:  func(m *model) tea.Cmd { return m.removeChat(chat, "me") }},
		menuItem{icon: "⇥", label: "Leave group", danger: true, confirm: "Leave the group?",
			action: func(m *model) tea.Cmd { return m.leaveGroup(chat) }},
	)

	if chat.Role == "owner" {
		items = append(items, menuItem{icon: "🗑", label: "Delete group", danger: true,
			confirm: "Delete the group for everyone?",
			action:  func(m *model) tea.Cmd { return m.removeChat(chat, "everyone") }})
	}

	return &menuState{title: m.chatName(chat), items: items, confirming: -1}
}

// openGroupInfo shows the group's members and actions (loading the
// members first if they are not there yet).
func (m *model) openGroupInfo(chat Chat) tea.Cmd {
	if m.chat == nil || m.chat.id != chat.ID {
		cmd := m.openChat(chat)
		m.menu = m.groupInfoMenu(chat)

		return cmd
	}

	m.menu = m.groupInfoMenu(chat)

	if m.members == nil {
		return m.loadMembers()
	}

	return nil
}

func roleLabel(role string) string {
	switch role {
	case "owner", "admin":
		return " · " + role
	}

	return ""
}

func (m *model) groupInfoMenu(chat Chat) *menuState {
	var items []menuItem
	title := fmt.Sprintf("%s · %d of %d members", m.chatName(chat), chat.MemberCount, maxGroupMembers)

	if m.groupDistrusted[chat.ID] {
		title += " · ⚠ a key came from a changed account key: compare safety codes"
	}

	if chat.isAdmin() {
		if chat.MemberCount < maxGroupMembers {
			items = append(items, menuItem{icon: "✚", label: "Add a member…", action: func(m *model) tea.Cmd {
				return m.openPrompt("Add to "+m.chatName(chat), "@username", "", "", 33, func(m *model, value string) tea.Cmd {
					return m.addMember(chat, cleanUsername(value))
				})
			}})
		}

		requests := "Asking to join"

		if chat.JoinRequests > 0 {
			requests = fmt.Sprintf("Asking to join (%d)", chat.JoinRequests)
		}

		items = append(items,
			menuItem{icon: "🔗", label: "Invite link…", action: func(m *model) tea.Cmd { return m.inviteMenu(chat) }},
			menuItem{icon: "?", label: requests, action: func(m *model) tea.Cmd { return m.requestsMenu(chat) }},
			menuItem{icon: "✎", label: "Rename…", action: func(m *model) tea.Cmd {
				return m.openPrompt("Rename the group", "Name", "", m.chatName(chat), 64, func(m *model, value string) tea.Cmd {
					return m.renameGroup(chat, value)
				})
			}},
			menuItem{icon: "🔑", label: "Change the group key", action: func(m *model) tea.Cmd { return m.rotateKey(chat) }},
		)
	}

	if m.members == nil {
		items = append(items, menuItem{icon: " ", label: "Loading members…", action: func(m *model) tea.Cmd {
			return m.openGroupInfo(chat)
		}})
	}

	for _, member := range m.members {
		member := member
		label := "@" + member.Username + roleLabel(member.Role)
		icon := "·"

		if member.ID == m.user.User.ID {
			label += " (you)"
		} else if m.connStatus == connOnline && m.presence[member.ID].online {
			icon = "●"
		}

		items = append(items, menuItem{icon: icon, label: label, action: func(m *model) tea.Cmd {
			if member.ID == m.user.User.ID {
				m.menu = m.groupInfoMenu(chat)
				return nil
			}

			m.menu = m.memberMenu(chat, member)

			return nil
		}})
	}

	items = append(items, menuItem{icon: "⇥", label: "Leave group", danger: true, confirm: "Leave the group?",
		action: func(m *model) tea.Cmd { return m.leaveGroup(chat) }})

	if chat.Role == "owner" {
		items = append(items, menuItem{icon: "🗑", label: "Delete group", danger: true,
			confirm: "Delete the group for everyone?",
			action:  func(m *model) tea.Cmd { return m.removeChat(chat, "everyone") }})
	}

	return &menuState{title: title, items: items, confirming: -1, groupInfo: chat.ID}
}

// memberMenu: what can be done with a group's member.
func (m *model) memberMenu(chat Chat, member groupMember) *menuState {
	items := []menuItem{
		{icon: "✉", label: "Message @" + member.Username, action: func(m *model) tea.Cmd {
			return m.messageMember(member.Username)
		}},
	}

	if member.PublicKey != "" {
		items = append(items, menuItem{icon: "🛡", label: "Safety code", action: func(m *model) tea.Cmd {
			user := member.foundUser
			m.safetyPeer = &user
			m.safetyOpen = true

			return nil
		}})
	}

	if chat.Role == "owner" && member.Role != "owner" {
		role, label := "admin", "Make admin"

		if member.Role == "admin" {
			role, label = "member", "Remove admin"
		}

		items = append(items, menuItem{icon: "★", label: label, action: func(m *model) tea.Cmd {
			return m.setRole(chat, member, role)
		}})
	}

	if chat.Role == "owner" && member.Role != "owner" || chat.Role == "admin" && member.Role == "member" {
		items = append(items, menuItem{icon: "✕", label: "Remove from the group", danger: true,
			confirm: "Remove @" + member.Username + "?",
			action:  func(m *model) tea.Cmd { return m.removeMember(chat, member) }})
	}

	items = append(items, menuItem{icon: "‹", label: "Back", action: func(m *model) tea.Cmd {
		m.menu = m.groupInfoMenu(chat)
		return nil
	}})

	return &menuState{title: "@" + member.Username + roleLabel(member.Role), items: items, confirming: -1}
}

// messageMember opens (or starts) the direct chat with a member.
func (m *model) messageMember(username string) tea.Cmd {
	for _, chat := range m.chats {
		if chat.Type != "group" && strings.EqualFold(chat.Username, username) {
			return m.openChat(chat)
		}
	}

	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		chat, err := createChat(token, username)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if m.findChat(chat.ID) < 0 {
				m.chats = append([]Chat{chat}, m.chats...)
			}

			return tea.Batch(m.openChat(chat), m.loadChats())
		}
	})
}
