package main

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	zone "github.com/lrstanley/bubblezone"
)

// Action menus over the screen (a message's, a chat's) and the safety
// code.

type menuItem struct {
	icon, label string
	danger      bool
	// Destructive actions take a second Enter: the label shown after the
	// first.
	confirm string
	action  func(*model) tea.Cmd
}

type menuState struct {
	title string
	// A message's menu starts with its reactions.
	reactionsFor *Message
	items        []menuItem
	// -1: the reactions row.
	cursor int
	// Position in the reactions row.
	reaction   int
	confirming int
}

func (m *model) openMenu(menu *menuState) {
	m.menu = menu
}

// focusLabel puts the cursor on an item and asks for its confirmation.
func (menu *menuState) focusLabel(label string) {
	for i, item := range menu.items {
		if item.label == label {
			menu.cursor = i

			if item.confirm != "" {
				menu.confirming = i
			}
		}
	}
}

func (m *model) messageMenu(chat Chat, message Message) *menuState {
	own := message.SenderID == m.user.User.ID
	shown := m.show(chat, message.ID, message.SenderID, message.Content)
	title := oneLine(sanitize(plainText(shown.text)))
	copyItem := menuItem{icon: "⧉", label: "Copy text", action: func(m *model) tea.Cmd { return m.copyMessage(chat, message) }}

	// Still on its way: it can only be sent again, copied or dropped.
	if state := m.outgoingState(message.ID); state != "" {
		var items []menuItem

		if state == "failed" {
			label := "Send again"

			if i := m.findOutgoing(message.ID); i >= 0 && m.outgoing[i].err != "" {
				label += " (" + m.outgoing[i].err + ")"
			}

			items = append(items, menuItem{icon: "↻", label: label, action: func(m *model) tea.Cmd {
				m.chat.resetSelection()
				return m.attemptSend(message.ID)
			}})
		}

		items = append(items, copyItem, menuItem{icon: "🗑", label: "Delete", danger: true, action: func(m *model) tea.Cmd {
			m.chat.resetSelection()
			m.dropOutgoing(message.ID)

			return m.chat.composer.Focus()
		}})

		return &menuState{title: title, items: items, confirming: -1}
	}

	items := []menuItem{
		{icon: "↪", label: "Reply", action: func(m *model) tea.Cmd { return m.startReply(message) }},
		copyItem,
	}

	if shown.status == decryptOK {
		items = append(items, menuItem{icon: "↷", label: "Forward", action: func(m *model) tea.Cmd {
			m.openMenu(m.forwardMenu(chat, message))
			return nil
		}})
	}

	pinned := chat.PinnedMessage != nil && chat.PinnedMessage.ID == message.ID
	pinLabel, pinID := "Pin", message.ID

	if pinned {
		pinLabel, pinID = "Unpin", ""
	}

	items = append(items, menuItem{icon: "📌", label: pinLabel, action: func(m *model) tea.Cmd { return m.pinMessage(chat, pinID) }})

	if message.ReplyTo != nil {
		reply := message.ReplyTo.ID
		items = append(items, menuItem{icon: "⤴", label: "Show quoted message", action: func(m *model) tea.Cmd {
			return m.showQuoted(reply)
		}})
	}

	if own && shown.status == decryptOK && shown.forwardedFrom == "" {
		items = append(items, menuItem{icon: "✎", label: "Edit", action: func(m *model) tea.Cmd { return m.startEdit(chat, message) }})
	}

	if own {
		items = append(items, menuItem{icon: "🗑", label: "Delete", danger: true, confirm: "Delete for everyone?", action: func(m *model) tea.Cmd {
			m.chat.resetSelection()
			return tea.Batch(m.deleteMessage(message), m.chat.composer.Focus())
		}})
	}

	return &menuState{
		title:        title,
		reactionsFor: &message,
		items:        items,
		confirming:   -1,
	}
}

// forwardMenu: the chats a message can be forwarded to.
func (m *model) forwardMenu(from Chat, message Message) *menuState {
	var items []menuItem

	for _, target := range m.chats {
		if target.Blocked || target.PublicKey == "" {
			continue
		}

		target := target
		items = append(items, menuItem{icon: "→", label: "@" + target.Username, action: func(m *model) tea.Cmd {
			return m.forward(from, message, target)
		}})
	}

	if len(items) == 0 {
		items = append(items, menuItem{icon: " ", label: "No chats to forward to", action: func(*model) tea.Cmd { return nil }})
	}

	return &menuState{title: "Forward to…", items: items, confirming: -1}
}

// forward sends a message's text to another chat, encrypted for it, with
// whom it comes from; then opens that chat.
func (m *model) forward(from Chat, message Message, target Chat) tea.Cmd {
	shown := m.show(from, message.ID, message.SenderID, message.Content)
	origin := shown.forwardedFrom

	if origin == "" {
		origin = from.Username

		if message.SenderID == m.user.User.ID {
			origin = m.user.User.Username
		}
	}

	id := newMessageID()
	content, err := encryptMessage(encodePayload(payload{text: shown.text, forwardedFrom: origin}),
		id, m.user.User.ID, m.user.PrivateKey, target.PublicKey, target.ID)
	if err != nil {
		return m.showToast(err.Error(), true)
	}

	if m.chat != nil {
		m.chat.resetSelection()
	}

	return tea.Batch(m.queueMessage(target.ID, id, content, nil), m.openChat(target))
}

func (m *model) pinMessage(chat Chat, messageID string) tea.Cmd {
	if m.chat != nil {
		m.chat.resetSelection()
	}

	return m.chatAction(func(token string) error {
		return setPinnedMessage(token, chat.ID, messageID)
	}, "")
}

// chatMenu: the chat's actions; from the chat screen with search, safety
// code and blocking.
func (m *model) chatMenu(chat Chat, inChat bool) *menuState {
	var items []menuItem

	if inChat {
		items = append(items, menuItem{icon: "🔍", label: "Search in chat", action: func(m *model) tea.Cmd {
			return m.openChatSearch()
		}})

		if chat.PinnedMessage != nil {
			items = append(items, menuItem{icon: "📌", label: "Unpin message", action: func(m *model) tea.Cmd {
				return m.pinMessage(chat, "")
			}})
		}

		if chat.PublicKey != "" {
			items = append(items, menuItem{icon: "🛡", label: "Safety code", action: func(m *model) tea.Cmd {
				m.openSafety(chat)
				return nil
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
	)

	if inChat {
		block := menuItem{icon: "⊘", label: "Block @" + chat.Username, danger: true,
			confirm: "Block? They won't be able to message you",
			action:  func(m *model) tea.Cmd { return m.setBlocked(chat, true) }}

		if chat.BlockedByMe {
			block = menuItem{icon: "⊘", label: "Unblock @" + chat.Username,
				action: func(m *model) tea.Cmd { return m.setBlocked(chat, false) }}
		}

		items = append(items, block)
	}

	items = append(items,
		menuItem{icon: "◌", label: "Clear history for me", danger: true,
			confirm: "Clear? @" + chat.Username + " keeps the messages",
			action:  func(m *model) tea.Cmd { return m.removeChat(chat, "me") }},
		menuItem{icon: "🗑", label: "Delete for both", danger: true,
			confirm: "Delete the chat for both of you?",
			action:  func(m *model) tea.Cmd { return m.removeChat(chat, "everyone") }},
	)

	return &menuState{title: "@" + chat.Username, items: items, confirming: -1}
}

// chooseItem runs an item (or asks for confirmation first).
func (m *model) chooseItem(i int) tea.Cmd {
	menu := m.menu
	item := menu.items[i]

	if item.confirm != "" && menu.confirming != i {
		menu.confirming = i
		menu.cursor = i

		return nil
	}

	m.menu = nil

	return item.action(m)
}

func (m *model) chooseReaction(i int) tea.Cmd {
	message := *m.menu.reactionsFor
	m.menu = nil

	if m.outgoingState(message.ID) != "" {
		return nil
	}

	if m.chat != nil {
		m.chat.resetSelection()
		cmd := m.chat.composer.Focus()

		return tea.Batch(cmd, m.react(message, reactionEmoji[i]))
	}

	return nil
}

func (m *model) closeMenu() tea.Cmd {
	m.menu = nil

	return nil
}

func (m *model) updateMenuKey(msg tea.KeyMsg) tea.Cmd {
	menu := m.menu
	first := 0

	if menu.reactionsFor != nil {
		first = -1
	}

	switch key := msg.String(); key {
	case "esc", "q":
		return m.closeMenu()
	case "up", "k", "shift+tab":
		menu.cursor = max(menu.cursor-1, first)
		menu.confirming = -1
	case "down", "j", "tab":
		menu.cursor = min(menu.cursor+1, len(menu.items)-1)
		menu.confirming = -1
	case "left", "h":
		if menu.cursor == -1 {
			menu.reaction = max(menu.reaction-1, 0)
		}
	case "right", "l":
		if menu.cursor == -1 {
			menu.reaction = min(menu.reaction+1, len(reactionEmoji)-1)
		}
	case "enter", " ":
		if menu.cursor == -1 {
			return m.chooseReaction(menu.reaction)
		}

		return m.chooseItem(menu.cursor)
	default:
		if menu.reactionsFor != nil && len(key) == 1 && key[0] >= '1' && key[0] < '1'+byte(len(reactionEmoji)) {
			return m.chooseReaction(int(key[0] - '1'))
		}
	}

	return nil
}

func (m *model) updateMenuMouse(msg tea.MouseMsg) tea.Cmd {
	if msg.Action != tea.MouseActionPress || msg.Button != tea.MouseButtonLeft {
		return nil
	}

	for i := range reactionEmoji {
		if clicked(msg, fmt.Sprintf("menu:reaction:%d", i)) {
			return m.chooseReaction(i)
		}
	}

	for i := range m.menu.items {
		if clicked(msg, fmt.Sprintf("menu:item:%d", i)) {
			return m.chooseItem(i)
		}
	}

	// A click outside the menu closes it.
	if !zone.Get("menu").InBounds(msg) {
		return m.closeMenu()
	}

	return nil
}

func (m model) menuView() string {
	menu := m.menu
	p := m.pal
	bg := p.panel
	w := min(46, m.width-4)
	inner := w - 4
	var lines []string

	if menu.title != "" {
		lines = append(lines, seg(clip(menu.title, inner), p.muted, bg), "")
	}

	if message := menu.reactionsFor; message != nil {
		var chips []string

		for i, emoji := range reactionEmoji {
			chipBg := bg

			for _, r := range message.Reactions {
				if r.UserID == m.user.User.ID && r.Emoji == emoji {
					chipBg = p.accentSoft
				}
			}

			if menu.cursor == -1 && menu.reaction == i {
				chipBg = p.hover
			}

			chips = append(chips, zone.Mark(fmt.Sprintf("menu:reaction:%d", i), seg(" "+emoji+" ", p.text, chipBg)))
		}

		lines = append(lines, center(strings.Join(chips, ""), inner, bg), "")
	}

	for i, item := range menu.items {
		fg := p.text

		if item.danger {
			fg = p.danger
		}

		label := item.label

		if menu.confirming == i {
			label = item.confirm
		}

		itemBg := bg

		if menu.cursor == i {
			itemBg = p.hover
		}

		line := fitLine(seg(" "+item.icon+"  ", fg, itemBg)+bold(clip(sanitize(label), inner-6), fg, itemBg), inner, itemBg)
		lines = append(lines, zone.Mark(fmt.Sprintf("menu:item:%d", i), line))
	}

	hints := "↑↓ Choose  Enter Select  Esc Close"

	if menu.reactionsFor != nil {
		hints = "1–8 React  ↑↓ Choose  Enter Select  Esc Close"
	}

	lines = append(lines, "", seg(clip(hints, inner), p.muted, bg))

	return zone.Mark("menu", m.card(lines, w))
}

// --- safety code ---

func (m *model) openSafety(chat Chat) {
	if chat.PublicKey == "" {
		return
	}

	m.safetyOpen = true
}

func (m *model) confirmSafety() {
	if chat, ok := m.chatByID(m.chat.id); ok && m.keyChanged[chat.UserID] {
		m.acceptPeerKey(chat)
	}

	m.safetyOpen = false
}

func (m *model) updateSafetyKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "y", "Y":
		m.confirmSafety()
	case "esc", "enter", "q", "ctrl+k":
		m.safetyOpen = false
	}

	return nil
}

func (m *model) updateSafetyMouse(msg tea.MouseMsg) tea.Cmd {
	switch {
	case clicked(msg, "safety:confirm"):
		m.confirmSafety()
	case clicked(msg, "safety:close"):
		m.safetyOpen = false
	case msg.Action == tea.MouseActionPress && !zone.Get("safety").InBounds(msg):
		m.safetyOpen = false
	}

	return nil
}

func (m model) safetyView() string {
	p := m.pal
	bg := p.panel
	chat, _ := m.chatByID(m.chat.id)
	name := sanitize(chat.Username)
	w := min(60, m.width-4)
	inner := w - 4
	changed := m.keyChanged[chat.UserID]

	own, err := publicKeyOf(m.user.PrivateKey)
	var code []string

	if err == nil {
		code, err = safetyCode(own, chat.PublicKey)
	}

	icon, iconColor := "🛡", p.accent

	if changed {
		icon, iconColor = "⚠", p.danger
	}

	lines := []string{
		seg(icon+"  ", iconColor, bg) + bold("Safety code with @"+name, p.text, bg),
		"",
	}

	if err != nil {
		lines = append(lines, seg(clip(err.Error(), inner), p.danger, bg))
	} else {
		box := p.panelAlt
		lines = append(lines,
			blank(inner, box),
			center(bold(strings.Join(code[:4], "  "), p.text, box), inner, box),
			center(bold(strings.Join(code[4:], "  "), p.text, box), inner, box),
			blank(inner, box),
		)
	}

	lines = append(lines, "")

	for _, line := range wrap("Compare it with the code @"+name+" sees for this chat, in person or over another app. If both are the same, your messages are readable only by the two of you.", inner) {
		lines = append(lines, seg(line, p.textSoft, bg))
	}

	if changed {
		lines = append(lines, "")

		for _, line := range wrap("The security key of @"+name+" has changed. That happens when they set up encryption again, but it can also mean someone is trying to read the chat. Write only after you have compared the codes.", inner) {
			lines = append(lines, seg(line, p.danger, bg))
		}

		lines = append(lines, "", zone.Mark("safety:confirm", m.button("The codes are the same (y)", inner, true, true)))
	}

	lines = append(lines, "", zone.Mark("safety:close", m.button("Close (Esc)", inner, false, true)))

	return zone.Mark("safety", m.card(lines, w))
}
