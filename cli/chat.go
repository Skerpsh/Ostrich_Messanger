package main

import (
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/cursor"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

// The open chat: history, sending, replies, edits, reactions, deleting,
// search, older history.

const (
	maxMessageLength = 4096
	composerMaxLines = 6
	// Lines scrolled per wheel step.
	wheelLines = 3
)

type chatState struct {
	id string

	messages []Message
	loaded   bool
	// There is older history to load (while scrolling up).
	hasMore      bool
	loadingOlder bool
	firstLoad    bool
	// Where unread messages started when the chat was opened.
	unreadAfter *string

	composer textarea.Model
	replyTo  *Message
	editing  *Message
	sending  bool

	// Choosing a message with the keyboard (↑ in an empty composer).
	selecting bool
	selected  int

	// Lines scrolled up from the newest message.
	scroll int

	searching  bool
	search     textinput.Model
	matchIndex int

	// Briefly marked after jumping to it.
	highlight string

	err        string
	lastTyping time.Time

	// Drawn bubbles, by message and everything that changes them.
	cache map[string][]string
}

func newChatState(chatID string, p palette, w int) *chatState {
	c := &chatState{
		id:        chatID,
		firstLoad: true,
		cache:     map[string][]string{},
		search:    newInput("Search messages", 100, false, p),
	}

	c.composer = textarea.New()
	c.composer.Prompt = ""
	c.composer.Placeholder = "Message"
	c.composer.ShowLineNumbers = false
	c.composer.CharLimit = maxMessageLength
	c.composer.Cursor.SetMode(cursor.CursorStatic)
	c.composer.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("alt+enter", "ctrl+j"))
	c.composer.SetHeight(1)
	c.restyle(p)
	c.resize(w)

	return c
}

func (c *chatState) restyle(p palette) {
	style := textarea.Style{
		Base:             lipgloss.NewStyle().Background(p.panelAlt),
		CursorLine:       lipgloss.NewStyle().Foreground(p.text).Background(p.panelAlt),
		CursorLineNumber: lipgloss.NewStyle().Background(p.panelAlt),
		EndOfBuffer:      lipgloss.NewStyle().Foreground(p.panelAlt).Background(p.panelAlt),
		LineNumber:       lipgloss.NewStyle().Background(p.panelAlt),
		Placeholder:      lipgloss.NewStyle().Foreground(p.muted).Background(p.panelAlt),
		Prompt:           lipgloss.NewStyle().Background(p.panelAlt),
		Text:             lipgloss.NewStyle().Foreground(p.text).Background(p.panelAlt),
	}

	c.composer.FocusedStyle = style
	c.composer.BlurredStyle = style

	// The textarea draws with the style chosen by its last Focus / Blur.
	if c.composer.Focused() {
		c.composer.Focus()
	} else {
		c.composer.Blur()
	}
	c.composer.Cursor.Style = lipgloss.NewStyle().Foreground(p.accent).Background(p.panelAlt)
	c.composer.Cursor.TextStyle = style.Text
	styleInput(&c.search, p)
	c.cache = map[string][]string{}
}

// The composer sits in a box with the send button next to it.
func (c *chatState) resize(w int) {
	c.composer.SetWidth(max(w-10, 10))
	c.search.Width = max(w-30, 10)
	c.fitComposer()
}

// fitComposer grows the composer with its text, up to a limit.
func (c *chatState) fitComposer() {
	c.composer.SetHeight(min(max(c.composer.LineCount(), 1), composerMaxLines))
}

func (c *chatState) indexOf(messageID string) int {
	for i, message := range c.messages {
		if message.ID == messageID {
			return i
		}
	}

	return -1
}

func sortMessages(messages []Message) {
	sort.SliceStable(messages, func(i, j int) bool {
		a, b := parseTime(&messages[i].CreatedAt), parseTime(&messages[j].CreatedAt)

		if a != nil && b != nil && !a.Equal(*b) {
			return a.Before(*b)
		}

		return messages[i].ID < messages[j].ID
	})
}

// mergeMessages adds messages (or newer versions of them), oldest first.
func (c *chatState) mergeMessages(messages []Message) {
	selectedID := c.selectedID()

	for _, message := range messages {
		if i := c.indexOf(message.ID); i >= 0 {
			c.messages[i] = message
		} else {
			c.messages = append(c.messages, message)
		}
	}

	sortMessages(c.messages)
	c.reselect(selectedID)
}

// reconcile merges a freshly loaded page of the newest history: messages
// within its time span that are not in it were deleted meanwhile (e.g.
// while offline). complete: the page reaches back to the start.
func (c *chatState) reconcile(page []Message, complete bool) {
	if len(page) == 0 {
		if complete {
			c.messages = nil
			c.resetSelection()
		}

		return
	}

	ids := map[string]bool{}

	for _, message := range page {
		ids[message.ID] = true
	}

	from := parseTime(&page[0].CreatedAt)
	to := parseTime(&page[len(page)-1].CreatedAt)
	selectedID := c.selectedID()
	kept := make([]Message, 0, len(c.messages))

	for _, message := range c.messages {
		at := parseTime(&message.CreatedAt)
		outside := at != nil && from != nil && to != nil &&
			((!complete && at.Before(*from)) || at.After(*to))

		if ids[message.ID] || outside {
			kept = append(kept, message)
		}
	}

	c.messages = kept
	c.mergeMessages(page)
	c.reselect(selectedID)
}

func (c *chatState) selectedID() string {
	if c.selecting && c.selected < len(c.messages) {
		return c.messages[c.selected].ID
	}

	return ""
}

// reselect keeps the selection on the same message after changes.
func (c *chatState) reselect(messageID string) {
	if !c.selecting {
		return
	}

	if i := c.indexOf(messageID); i >= 0 {
		c.selected = i
	} else if c.selected >= len(c.messages) {
		c.resetSelection()
	}
}

func (c *chatState) resetSelection() {
	c.selecting = false
	c.selected = 0
}

func (c *chatState) removeMessage(messageID string) {
	i := c.indexOf(messageID)

	if i < 0 {
		return
	}

	selectedID := c.selectedID()
	c.messages = append(c.messages[:i], c.messages[i+1:]...)

	if c.editing != nil && c.editing.ID == messageID {
		c.editing = nil
		c.composer.SetValue("")
	}

	if c.replyTo != nil && c.replyTo.ID == messageID {
		c.replyTo = nil
	}

	if selectedID == messageID {
		c.selected = min(c.selected, len(c.messages)-1)
		c.selecting = c.selected >= 0
	} else {
		c.reselect(selectedID)
	}
}

func (c *chatState) replaceMessage(message Message) {
	if i := c.indexOf(message.ID); i >= 0 {
		c.messages[i] = message
	}
}

func (c *chatState) setReactions(messageID string, reactions []Reaction) {
	if i := c.indexOf(messageID); i >= 0 {
		c.messages[i].Reactions = reactions
	}
}

// --- opening and loading ---

func (m *model) openChat(chat Chat) tea.Cmd {
	if m.chat != nil && m.chat.id != chat.ID {
		m.send(map[string]string{"type": "leave", "chatId": m.chat.id})
	}

	m.settings = nil
	m.safetyOpen = false

	if m.chat == nil || m.chat.id != chat.ID {
		m.chat = newChatState(chat.ID, m.pal, m.paneWidth())
		m.send(map[string]string{"type": "join", "chatId": chat.ID})
	}

	m.focus = paneChat
	m.list.selectChat(*m, chat.ID)

	return tea.Batch(m.chat.composer.Focus(), m.loadHistory(chat.ID, ""))
}

func (m *model) closeChat() {
	if m.chat != nil {
		m.send(map[string]string{"type": "leave", "chatId": m.chat.id})
	}

	m.chat = nil
	m.safetyOpen = false
	m.focus = paneList
}

// loadHistory loads the newest messages, or those before `before`.
func (m *model) loadHistory(chatID, before string) tea.Cmd {
	token := m.user.Token

	if before != "" {
		m.chat.loadingOlder = true
	}

	return task(func() func(*model) tea.Cmd {
		page, err := getMessages(token, chatID, before)

		return func(m *model) tea.Cmd {
			c := m.chat

			if c == nil || c.id != chatID || m.user == nil || m.user.Token != token {
				return nil
			}

			if before != "" {
				c.loadingOlder = false
			}

			if err != nil {
				c.loaded = true
				return m.fail(err)
			}

			if before != "" {
				c.mergeMessages(page.Messages)
				c.hasMore = page.HasMore

				return nil
			}

			c.reconcile(page.Messages, !page.HasMore)
			c.loaded = true

			if c.firstLoad {
				c.firstLoad = false
				c.unreadAfter = page.LastReadAt
				c.hasMore = page.HasMore
			}

			if i := m.findChat(chatID); i >= 0 && later(page.PeerLastReadAt, m.chats[i].PeerLastReadAt) {
				m.chats[i].PeerLastReadAt = page.PeerLastReadAt
			}

			// Mark read what arrived while away.
			if n := len(page.Messages); n > 0 && m.viewing(chatID) {
				newest := page.Messages[n-1]

				if newest.SenderID != m.user.User.ID && later(&newest.CreatedAt, page.LastReadAt) {
					return m.markRead(chatID, newest.ID)
				}
			}

			return nil
		}
	})
}

// maybeLoadOlder loads older history once scrolled to the top.
func (m *model) maybeLoadOlder() tea.Cmd {
	c := m.chat

	if c == nil || !c.hasMore || c.loadingOlder || len(c.messages) == 0 {
		return nil
	}

	if c.scroll < m.maxChatScroll() {
		return nil
	}

	return m.loadHistory(c.id, c.messages[0].ID)
}

// --- keys ---

func (m *model) updateChatKey(msg tea.KeyMsg) tea.Cmd {
	c := m.chat
	chat, _ := m.chatByID(c.id)

	if c.searching {
		return m.updateChatSearchKey(msg)
	}

	if c.selecting {
		return m.updateSelectingKey(msg, chat)
	}

	switch msg.String() {
	case "esc":
		switch {
		case c.replyTo != nil:
			c.replyTo = nil
		case c.editing != nil:
			m.cancelEdit()
		case c.err != "":
			c.err = ""
		default:
			c.composer.Blur()
			m.focus = paneList

			if !m.wide() {
				m.closeChat()
			}
		}

		return nil
	case "tab":
		if m.wide() {
			c.composer.Blur()
			m.focus = paneList
		}

		return nil
	case "enter":
		return m.sendComposer(chat)
	case "up":
		if c.composer.Value() == "" && len(c.messages) > 0 {
			c.selecting = true
			c.selected = len(c.messages) - 1
			c.composer.Blur()
			m.scrollToMessage(c.selected)

			return nil
		}
	case "pgup":
		c.scroll = min(c.scroll+max(m.chatAreaHeight()-2, 1), m.maxChatScroll())
		return m.maybeLoadOlder()
	case "pgdown":
		c.scroll = max(c.scroll-max(m.chatAreaHeight()-2, 1), 0)
		return nil
	case "ctrl+f":
		return m.openChatSearch()
	case "ctrl+k":
		m.openSafety(chat)
		return nil
	case "ctrl+o":
		m.openMenu(m.chatMenu(chat, true))
		return nil
	}

	before := c.composer.Value()

	var cmd tea.Cmd
	c.composer, cmd = c.composer.Update(msg)
	c.fitComposer()

	// "typing…" for the other member, at most every few seconds.
	if value := c.composer.Value(); value != before && strings.TrimSpace(value) != "" &&
		c.editing == nil && time.Since(c.lastTyping) > typingInterval {
		c.lastTyping = time.Now()
		m.send(map[string]string{"type": "typing", "chatId": c.id})
	}

	return cmd
}

func (m *model) updateSelectingKey(msg tea.KeyMsg, chat Chat) tea.Cmd {
	c := m.chat

	if c.selected >= len(c.messages) {
		m.stopSelecting()
		return nil
	}

	message := c.messages[c.selected]
	own := message.SenderID == m.user.User.ID

	switch key := msg.String(); key {
	case "up", "k":
		if c.selected > 0 {
			c.selected--
		}

		m.scrollToMessage(c.selected)

		if c.selected == 0 {
			return m.maybeLoadOlderAtTop()
		}
	case "down", "j":
		if c.selected < len(c.messages)-1 {
			c.selected++
			m.scrollToMessage(c.selected)
		} else {
			return m.stopSelecting()
		}
	case "enter", " ", "m":
		m.openMenu(m.messageMenu(chat, message))
	case "r":
		return m.startReply(message)
	case "e":
		if own {
			return m.startEdit(chat, message)
		}
	case "d":
		if own {
			menu := m.messageMenu(chat, message)
			menu.focusLabel("Delete")
			m.openMenu(menu)
		}
	case "c":
		return m.copyMessage(chat, message)
	case "esc", "i":
		return m.stopSelecting()
	case "pgup":
		c.scroll = min(c.scroll+max(m.chatAreaHeight()-2, 1), m.maxChatScroll())
		return m.maybeLoadOlder()
	case "pgdown":
		c.scroll = max(c.scroll-max(m.chatAreaHeight()-2, 1), 0)
	default:
		// 1–8: react.
		if len(key) == 1 && key[0] >= '1' && key[0] < '1'+byte(len(reactionEmoji)) {
			return m.react(message, reactionEmoji[key[0]-'1'])
		}
	}

	return nil
}

// maybeLoadOlderAtTop loads older history when the selection reaches the
// oldest loaded message.
func (m *model) maybeLoadOlderAtTop() tea.Cmd {
	c := m.chat

	if c.hasMore && !c.loadingOlder && len(c.messages) > 0 {
		return m.loadHistory(c.id, c.messages[0].ID)
	}

	return nil
}

func (m *model) stopSelecting() tea.Cmd {
	m.chat.resetSelection()
	m.chat.scroll = 0

	return m.chat.composer.Focus()
}

// --- search ---

func (m *model) openChatSearch() tea.Cmd {
	c := m.chat
	c.searching = true
	c.search.SetValue("")
	c.matchIndex = 0
	c.composer.Blur()

	return c.search.Focus()
}

func (m *model) closeChatSearch() tea.Cmd {
	c := m.chat
	c.searching = false
	c.search.Blur()
	c.highlight = ""

	return c.composer.Focus()
}

// matches are the ids of loaded messages containing the search text,
// newest first.
func (m model) matches() []string {
	c := m.chat
	query := strings.ToLower(strings.TrimSpace(c.search.Value()))

	if query == "" {
		return nil
	}

	chat, _ := m.chatByID(c.id)
	var ids []string

	for i := len(c.messages) - 1; i >= 0; i-- {
		message := c.messages[i]
		text, _ := m.decrypt(chat, message.ID, message.SenderID, message.Content)

		if strings.Contains(strings.ToLower(text), query) {
			ids = append(ids, message.ID)
		}
	}

	return ids
}

func (m *model) updateChatSearchKey(msg tea.KeyMsg) tea.Cmd {
	c := m.chat

	switch msg.String() {
	case "esc":
		return m.closeChatSearch()
	case "enter", "up":
		return m.goToMatch(c.matchIndex + 1)
	case "down":
		return m.goToMatch(c.matchIndex - 1)
	case "ctrl+l":
		return m.maybeLoadOlderAtTop()
	}

	var cmd tea.Cmd
	before := c.search.Value()
	c.search, cmd = c.search.Update(msg)

	if c.search.Value() != before {
		return tea.Batch(cmd, m.goToMatch(0))
	}

	return cmd
}

// goToMatch shows the n-th match (0 = newest); past the oldest loaded
// one, older history is loaded.
func (m *model) goToMatch(n int) tea.Cmd {
	c := m.chat
	matches := m.matches()

	if len(matches) == 0 {
		c.highlight = ""
		return nil
	}

	if n >= len(matches) {
		n = len(matches) - 1

		if cmd := m.maybeLoadOlderAtTop(); cmd != nil {
			return tea.Batch(cmd, m.showToast("Loading older messages…", false))
		}
	}

	c.matchIndex = max(n, 0)
	c.highlight = matches[c.matchIndex]
	m.scrollToMessage(c.indexOf(c.highlight))

	return nil
}

// --- actions ---

func (m *model) sendComposer(chat Chat) tea.Cmd {
	c := m.chat
	text := strings.TrimSpace(c.composer.Value())

	if text == "" || c.sending {
		return nil
	}

	switch {
	case chat.Blocked:
		c.err = "You can't message @" + chat.Username
		return nil
	case m.keyChanged[chat.UserID]:
		c.err = "The security key of @" + chat.Username + " has changed: compare the safety code first (Ctrl+K)"
		return nil
	}

	token := m.user.Token
	me := m.user.User.ID
	editing := c.editing
	replyTo := c.replyTo

	messageID := newMessageID()

	if editing != nil {
		messageID = editing.ID
	}

	encrypted, err := encryptMessage(text, messageID, me, m.user.PrivateKey, chat.PublicKey, chat.ID)
	if err != nil {
		c.err = err.Error()
		return nil
	}

	c.sending = true
	c.err = ""
	c.composer.SetValue("")
	c.fitComposer()
	c.editing = nil
	c.replyTo = nil

	if editing == nil {
		// Own messages end the "unread" part.
		c.unreadAfter = nil
		c.scroll = 0
	}

	return task(func() func(*model) tea.Cmd {
		var message Message
		var err error

		if editing != nil {
			message, err = editMessage(token, chat.ID, messageID, encrypted)
		} else {
			replyID := ""

			if replyTo != nil {
				replyID = replyTo.ID
			}

			message, err = sendMessage(token, chat.ID, messageID, encrypted, replyID)
		}

		return func(m *model) tea.Cmd {
			c := m.chat

			if c == nil || c.id != chat.ID {
				return nil
			}

			c.sending = false

			if err != nil {
				// Give the text back unless something new was typed.
				if c.composer.Value() == "" {
					c.composer.SetValue(text)
					c.fitComposer()
					c.editing = editing
					c.replyTo = replyTo
				}

				if err == errSessionExpired {
					return m.fail(err)
				}

				c.err = err.Error()

				return nil
			}

			c.mergeMessages([]Message{message})

			return nil
		}
	})
}

func (m *model) startReply(message Message) tea.Cmd {
	c := m.chat
	c.resetSelection()
	c.editing = nil
	c.replyTo = &message
	c.scroll = 0

	return c.composer.Focus()
}

func (m *model) startEdit(chat Chat, message Message) tea.Cmd {
	c := m.chat
	c.resetSelection()
	c.replyTo = nil
	c.editing = &message
	text, _ := m.decrypt(chat, message.ID, message.SenderID, message.Content)
	c.composer.SetValue(text)
	c.fitComposer()
	c.scroll = 0

	return c.composer.Focus()
}

func (m *model) cancelEdit() {
	m.chat.editing = nil
	m.chat.composer.SetValue("")
	m.chat.fitComposer()
}

func (m *model) copyMessage(chat Chat, message Message) tea.Cmd {
	text, _ := m.decrypt(chat, message.ID, message.SenderID, message.Content)

	if err := copyText(text); err != nil {
		return m.showToast(err.Error(), true)
	}

	return m.showToast("Copied", false)
}

// react toggles a reaction: the same emoji again removes it.
func (m *model) react(message Message, emoji string) tea.Cmd {
	c := m.chat
	me := m.user.User.ID
	next := emoji
	var reactions []Reaction

	for _, r := range message.Reactions {
		if r.UserID == me {
			if r.Emoji == emoji {
				next = ""
			}

			continue
		}

		reactions = append(reactions, r)
	}

	if next != "" {
		reactions = append(reactions, Reaction{Emoji: next, UserID: me})
	}

	c.setReactions(message.ID, reactions)

	token, chatID := m.user.Token, c.id

	return task(func() func(*model) tea.Cmd {
		result, err := setReaction(token, chatID, message.ID, next)

		return func(m *model) tea.Cmd {
			if m.chat == nil || m.chat.id != chatID {
				return nil
			}

			if err != nil {
				m.chat.setReactions(message.ID, message.Reactions)
				return m.fail(err)
			}

			m.chat.setReactions(message.ID, result)

			return nil
		}
	})
}

func (m *model) deleteMessage(message Message) tea.Cmd {
	token, chatID := m.user.Token, m.chat.id

	return task(func() func(*model) tea.Cmd {
		err := deleteMessage(token, chatID, message.ID)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if m.chat != nil && m.chat.id == chatID {
				m.chat.removeMessage(message.ID)
			}

			return nil
		}
	})
}

// showQuoted jumps to the message a reply quotes, if it is loaded.
func (m *model) showQuoted(messageID string) tea.Cmd {
	c := m.chat
	i := c.indexOf(messageID)

	if i < 0 {
		return m.showToast("The quoted message is not loaded", true)
	}

	c.highlight = messageID
	m.scrollToMessage(i)

	id := messageID

	return tea.Tick(2*time.Second, func(time.Time) tea.Msg {
		return resultMsg{apply: func(m *model) tea.Cmd {
			if m.chat != nil && m.chat.highlight == id && !m.chat.searching {
				m.chat.highlight = ""
			}

			return nil
		}}
	})
}

// --- chat settings ---

// chatAction runs a change of the chat and reloads the chats list.
func (m *model) chatAction(work func(token string) error, done string) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		err := work(token)

		return func(m *model) tea.Cmd {
			if m.user == nil {
				return nil
			}

			if err != nil {
				return tea.Batch(m.fail(err), m.loadChats())
			}

			var toast tea.Cmd

			if done != "" {
				toast = m.showToast(done, false)
			}

			return tea.Batch(toast, m.loadChats())
		}
	})
}

func (m *model) setPinned(chat Chat, pinned bool) tea.Cmd {
	return m.chatAction(func(token string) error {
		return setChatSettings(token, chat.ID, &pinned, nil)
	}, "")
}

func (m *model) setMuted(chat Chat, muted bool) tea.Cmd {
	return m.chatAction(func(token string) error {
		return setChatSettings(token, chat.ID, nil, &muted)
	}, "")
}

func (m *model) setBlocked(chat Chat, blocked bool) tea.Cmd {
	done := "@" + chat.Username + " is blocked"

	if !blocked {
		done = "@" + chat.Username + " is unblocked"
	}

	return m.chatAction(func(token string) error {
		return setBlocked(token, chat.UserID, blocked)
	}, done)
}

// removeChat deletes the chat for both ("everyone") or clears it for
// this user ("me").
func (m *model) removeChat(chat Chat, scope string) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		err := deleteChat(token, chat.ID, scope)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if i := m.findChat(chat.ID); i >= 0 {
				m.chats = append(m.chats[:i], m.chats[i+1:]...)
			}

			if m.chat != nil && m.chat.id == chat.ID {
				m.closeChat()
			}

			m.list.cursor = min(m.list.cursor, max(len(m.listRows())-1, 0))

			done := "Chat deleted"

			if scope == "me" {
				done = "History cleared"
			}

			return m.showToast(done, false)
		}
	})
}

// --- mouse ---

func (m *model) updateChatMouse(msg tea.MouseMsg) tea.Cmd {
	c := m.chat
	chat, _ := m.chatByID(c.id)

	if d := wheel(msg, "chat:messages"); d != 0 {
		if d < 0 {
			c.scroll = min(c.scroll+wheelLines, m.maxChatScroll())
			return m.maybeLoadOlder()
		}

		c.scroll = max(c.scroll-wheelLines, 0)

		return nil
	}

	switch {
	case clicked(msg, "chat:back"):
		m.closeChat()
		return nil
	case clicked(msg, "chat:search"):
		m.focus = paneChat
		return m.openChatSearch()
	case clicked(msg, "chat:safety"), clicked(msg, "chat:keywarning"):
		m.openSafety(chat)
		return nil
	case clicked(msg, "chat:menu"):
		m.openMenu(m.chatMenu(chat, true))
		return nil
	case clicked(msg, "chat:error"):
		c.err = ""
		return nil
	case clicked(msg, "chat:cancel"):
		if c.editing != nil {
			m.cancelEdit()
		}

		c.replyTo = nil

		return nil
	case clicked(msg, "chat:unblock"):
		return m.setBlocked(chat, false)
	case clicked(msg, "chat:send"):
		return m.sendComposer(chat)
	case clicked(msg, "chat:searchclose"):
		return m.closeChatSearch()
	case clicked(msg, "chat:older"):
		return m.maybeLoadOlderAtTop()
	case clicked(msg, "chat:composer"):
		m.focus = paneChat
		c.resetSelection()

		if c.searching {
			c.searching = false
			c.search.Blur()
		}

		return c.composer.Focus()
	}

	// A message: left click selects it and opens its menu (or follows a
	// quote), right click opens the menu.
	if msg.Action != tea.MouseActionPress ||
		(msg.Button != tea.MouseButtonLeft && msg.Button != tea.MouseButtonRight) {
		return nil
	}

	area := zone.Get("chat:messages")

	if !area.InBounds(msg) {
		return nil
	}

	_, y := area.Pos(msg)
	lines := m.chatLines(m.paneWidth())
	start, _ := m.chatWindow(len(lines.text))

	if at := start + y; at >= 0 && at < len(lines.meta) {
		meta := lines.meta[at]

		if meta.message < 0 {
			return nil
		}

		m.focus = paneChat
		message := c.messages[meta.message]

		if meta.quote && msg.Button == tea.MouseButtonLeft && message.ReplyTo != nil {
			return m.showQuoted(message.ReplyTo.ID)
		}

		c.selecting = true
		c.selected = meta.message
		c.composer.Blur()
		m.openMenu(m.messageMenu(chat, message))
	}

	return nil
}

// --- scrolling ---

// chatAreaHeight is the height of the messages area.
func (m model) chatAreaHeight() int {
	return max(m.height-m.chatChromeHeight(), 1)
}

// maxChatScroll is the scroll at which the oldest message is at the top.
func (m model) maxChatScroll() int {
	lines := m.chatLines(m.paneWidth())

	return max(len(lines.text)-m.chatAreaHeight(), 0)
}

// chatWindow is the range of message lines on screen.
func (m model) chatWindow(total int) (start, end int) {
	area := m.chatAreaHeight()
	scroll := min(m.chat.scroll, max(total-area, 0))
	end = total - scroll
	start = max(end-area, 0)

	return start, end
}

// scrollToMessage scrolls so that the message is on screen.
func (m *model) scrollToMessage(index int) {
	c := m.chat

	if index < 0 {
		return
	}

	lines := m.chatLines(m.paneWidth())
	area := m.chatAreaHeight()
	total := len(lines.text)
	first, last := -1, -1

	for i, meta := range lines.meta {
		if meta.message == index {
			if first < 0 {
				first = i
			}

			last = i
		}
	}

	if first < 0 {
		return
	}

	start, end := m.chatWindow(total)

	switch {
	case last+1 > end:
		c.scroll = total - (last + 1)
	case first < start:
		c.scroll = total - min(first+area, total)
	}

	c.scroll = min(max(c.scroll, 0), max(total-area, 0))
}

// unreadLine: the message index before which "Unread messages" goes, or
// -1.
func (m model) unreadLine() int {
	c := m.chat

	if c.unreadAfter == nil {
		return -1
	}

	for i, message := range c.messages {
		if message.SenderID != m.user.User.ID && later(&message.CreatedAt, c.unreadAfter) {
			return i
		}
	}

	return -1
}

// formatQuote names the quoted message's sender.
func (m model) quoteSender(reply *ReplyPreview) string {
	if reply.SenderID == m.user.User.ID {
		return "You"
	}

	return sanitize(reply.SenderUsername)
}
