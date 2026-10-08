package main

import (
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/gorilla/websocket"
)

// The session's websocket: new messages and events of all chats, presence,
// "typing…". Reconnects by itself; after a reconnect the chats and the
// open chat's history are reloaded, so nothing is missed.

type wsConnectedMsg struct {
	gen  int
	conn *websocket.Conn
}

type wsConnectErrorMsg struct {
	gen int
	err error
}

type wsMessageMsg struct {
	conn    *websocket.Conn
	message WSMessage
}

type wsErrorMsg struct {
	conn *websocket.Conn
	err  error
}

// connectCmd opens the session's websocket after the given delay (used
// for reconnect attempts).
func connectCmd(token string, gen int, delay time.Duration) tea.Cmd {
	return func() tea.Msg {
		time.Sleep(delay)

		conn, err := connectWebSocket(token)
		if err != nil {
			return wsConnectErrorMsg{gen: gen, err: err}
		}

		return wsConnectedMsg{gen: gen, conn: conn}
	}
}

func listenWebSocket(conn *websocket.Conn) tea.Cmd {
	return func() tea.Msg {
		var message WSMessage

		if err := conn.ReadJSON(&message); err != nil {
			return wsErrorMsg{conn: conn, err: err}
		}

		return wsMessageMsg{conn: conn, message: message}
	}
}

// closeConnection closes the websocket and cancels pending attempts.
func (m *model) closeConnection() {
	m.connGen++

	if m.conn != nil {
		m.conn.Close()
		m.conn = nil
	}

	m.connStatus = connOffline
}

// send writes to the websocket if it is open; errors show up as a closed
// connection, which reconnects.
func (m *model) send(payload map[string]string) {
	if m.conn != nil {
		_ = writeWebSocketJSON(m.conn, payload)
	}
}

func (m *model) loadChats() tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		chats, err := getChats(token)

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				return m.fail(err)
			}

			m.setChats(chats)

			return tea.Batch(m.loadGroupKeys(), m.loadMembers())
		}
	})
}

// setChats replaces the chats list, keeping the selection on the same
// chat.
func (m *model) setChats(chats []Chat) {
	selectedID := m.list.selectedChatID(*m)

	m.chats = chats
	m.chatsLoaded = true

	for _, chat := range chats {
		if chat.UserID != "" {
			m.setPresence(chat.UserID, chat.Online, chat.LastSeenAt)
		}
	}

	m.checkPeerKeys()
	m.list.selectChat(*m, selectedID)

	// The open chat may have been deleted elsewhere.
	if m.chat != nil && m.findChat(m.chat.id) < 0 {
		m.closeChat()
	}
}

func (m model) findChat(chatID string) int {
	for i, chat := range m.chats {
		if chat.ID == chatID {
			return i
		}
	}

	return -1
}

// chatByID returns the chat from the list.
func (m model) chatByID(chatID string) (Chat, bool) {
	if i := m.findChat(chatID); i >= 0 {
		return m.chats[i], true
	}

	return Chat{}, false
}

func (m *model) setPresence(userID string, online bool, lastSeenAt *string) {
	m.presence[userID] = presence{online: online, lastSeen: parseTime(lastSeenAt)}
}

func (m model) isTyping(chatID string) bool {
	return len(m.typingIn(chatID)) > 0
}

// typingIn: who is typing in the chat (user ids).
func (m model) typingIn(chatID string) []string {
	var users []string
	now := time.Now()

	for key, until := range m.typingUntil {
		if chat, user, ok := strings.Cut(key, "|"); ok && chat == chatID && now.Before(until) {
			users = append(users, user)
		}
	}

	sort.Strings(users)

	return users
}

func (m *model) updateRealtime(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case wsConnectedMsg:
		if msg.gen != m.connGen || m.user == nil || m.conn != nil {
			msg.conn.Close()
			return nil
		}

		m.conn = msg.conn
		m.connStatus = connOnline

		// Re-join the open chat; its "joined" answer reloads missed history.
		if m.chat != nil {
			m.send(map[string]string{"type": "join", "chatId": m.chat.id})
		}

		return tea.Batch(listenWebSocket(m.conn), m.loadChats(), m.flushOutbox())

	case wsConnectErrorMsg:
		if msg.gen != m.connGen || m.user == nil {
			return nil
		}

		if msg.err == errSessionExpired {
			return m.signOut(errSessionExpired.Error())
		}

		m.connStatus = connConnecting

		return connectCmd(m.user.Token, m.connGen, reconnectDelay)

	case wsErrorMsg:
		if msg.conn != m.conn || m.user == nil {
			return nil
		}

		m.conn.Close()
		m.conn = nil
		m.connStatus = connConnecting

		return connectCmd(m.user.Token, m.connGen, reconnectDelay)

	case wsMessageMsg:
		if msg.conn != m.conn {
			return nil
		}

		return tea.Batch(m.handleEvent(msg.message), listenWebSocket(m.conn))
	}

	return nil
}

// handleEvent applies one server event.
func (m *model) handleEvent(event WSMessage) tea.Cmd {
	switch event.Type {
	case "joined":
		if m.chat != nil && event.ChatID == m.chat.id {
			return m.loadHistory(m.chat.id, "")
		}

	case "message":
		if event.Message != nil {
			return m.messageArrived(*event.Message)
		}

	case "message_updated":
		if event.Message != nil {
			m.messageUpdated(*event.Message)
		}

	case "message_deleted":
		if m.chat != nil && m.chat.id == event.ChatID {
			m.chat.removeMessage(event.MessageID)
		}

		// A deleted pinned message is unpinned.
		if i := m.findChat(event.ChatID); i >= 0 {
			if pinned := m.chats[i].PinnedMessage; pinned != nil && pinned.ID == event.MessageID {
				m.chats[i].PinnedMessage = nil
			}
		}

		// The preview may need the message before it.
		if i := m.findChat(event.ChatID); i >= 0 {
			if last := m.chats[i].LastMessage; last != nil && last.ID == event.MessageID {
				return m.loadChats()
			}
		}

	case "reactions":
		if m.chat != nil && m.chat.id == event.ChatID {
			m.chat.setReactions(event.MessageID, event.Reactions)
		}

	case "typing":
		m.typingUntil[event.ChatID+"|"+event.UserID] = time.Now().Add(typingDuration)

	case "read":
		m.readEvent(event)

	case "presence":
		if event.UserID != "" {
			m.setPresence(event.UserID, event.Online, event.LastSeenAt)
		}

	case "profile":
		return m.profileEvent(event)

	case "chat_deleted":
		if i := m.findChat(event.ChatID); i >= 0 {
			m.chats = append(m.chats[:i], m.chats[i+1:]...)
		}

		if m.chat != nil && m.chat.id == event.ChatID {
			m.closeChat()
			return m.showToast("This chat was deleted", true)
		}

	case "pinned_message":
		if i := m.findChat(event.ChatID); i >= 0 {
			m.chats[i].PinnedMessage = nil

			if p := event.Message; p != nil {
				m.chats[i].PinnedMessage = &LastMessage{ID: p.ID, SenderID: p.SenderID, Content: p.Content, CreatedAt: p.CreatedAt}
			}
		}

	case "chats_changed":
		return m.loadChats()

	case "error":
		return m.showToast("Server: "+event.Error, true)
	}

	return nil
}

// messageArrived updates the list and the open chat with a new message.
func (m *model) messageArrived(message Message) tea.Cmd {
	i := m.findChat(message.ChatID)

	if i < 0 {
		// A chat someone has just started.
		return m.loadChats()
	}

	own := message.SenderID == m.user.User.ID
	viewing := m.viewing(message.ChatID)
	chat := m.chats[i]

	// The message ends the sender's "typing…".
	if !own {
		delete(m.typingUntil, message.ChatID+"|"+message.SenderID)
	}

	if chat.LastMessage == nil || chat.LastMessage.ID != message.ID {
		chat.LastMessage = &LastMessage{
			ID:             message.ID,
			SenderID:       message.SenderID,
			SenderUsername: message.SenderUsername,
			Kind:           message.Kind,
			Content:        message.Content,
			CreatedAt:      message.CreatedAt,
		}
		chat.Updated = message.CreatedAt

		switch {
		case own || viewing:
			chat.UnreadCount = 0
		default:
			chat.UnreadCount++

			if !chat.Muted && message.Kind != "system" {
				m.bell()
			}
		}

		m.moveToTop(chat)
	}

	if m.chat != nil && m.chat.id == message.ChatID {
		m.chat.mergeMessages([]Message{message})

		if viewing && !own {
			return m.markRead(message.ChatID, message.ID)
		}
	}

	return nil
}

// viewing tells whether the user is looking at the chat now.
func (m model) viewing(chatID string) bool {
	return m.chat != nil && m.chat.id == chatID && m.showingChat()
}

// moveToTop puts a chat with a new message first: of the pinned chats if
// it is pinned, otherwise right below them. The cursor stays on its chat.
func (m *model) moveToTop(chat Chat) {
	selectedID := m.list.selectedChatID(*m)
	rest := make([]Chat, 0, len(m.chats))

	for _, c := range m.chats {
		if c.ID != chat.ID {
			rest = append(rest, c)
		}
	}

	at := 0

	if !chat.Pinned {
		for at < len(rest) && rest[at].Pinned {
			at++
		}
	}

	m.chats = append(append(append([]Chat{}, rest[:at]...), chat), rest[at:]...)
	m.list.selectChat(*m, selectedID)
}

func (m *model) messageUpdated(message Message) {
	if m.chat != nil && m.chat.id == message.ChatID {
		m.chat.replaceMessage(message)
	}

	if i := m.findChat(message.ChatID); i >= 0 {
		if last := m.chats[i].LastMessage; last != nil && last.ID == message.ID {
			last.Content = message.Content
		}
	}
}

// readEvent: the other member read the chat (read receipts), or this user
// did on another device.
func (m *model) readEvent(event WSMessage) {
	i := m.findChat(event.ChatID)

	if i < 0 || event.LastReadAt == nil {
		return
	}

	if event.UserID != m.user.User.ID {
		if later(event.LastReadAt, m.chats[i].PeerLastReadAt) {
			m.chats[i].PeerLastReadAt = event.LastReadAt
		}

		return
	}

	last := m.chats[i].LastMessage
	readAt := parseTime(event.LastReadAt)

	if last == nil {
		m.chats[i].UnreadCount = 0
		return
	}

	if created := parseTime(&last.CreatedAt); created != nil && readAt != nil && !created.After(*readAt) {
		m.chats[i].UnreadCount = 0
	}
}

// later tells whether a is a later time than b (nil is the earliest).
func later(a, b *string) bool {
	ta, tb := parseTime(a), parseTime(b)

	return ta != nil && (tb == nil || ta.After(*tb))
}

// profileEvent: a contact (or the user elsewhere) changed name or photo.
func (m *model) profileEvent(event WSMessage) tea.Cmd {
	if event.UserID == m.user.User.ID {
		token := m.user.Token

		return task(func() func(*model) tea.Cmd {
			account, err := getMe(token)

			return func(m *model) tea.Cmd {
				if err == nil && m.user != nil && m.user.Token == token {
					m.user.User = *account
				}

				return nil
			}
		})
	}

	for i := range m.chats {
		if m.chats[i].UserID == event.UserID {
			m.chats[i].Username = event.Username
			m.chats[i].IsDeveloper = event.IsDeveloper
		}
	}

	return nil
}

// markRead marks the chat read up to the message.
func (m *model) markRead(chatID, messageID string) tea.Cmd {
	if i := m.findChat(chatID); i >= 0 {
		m.chats[i].UnreadCount = 0
	}

	token := m.user.Token

	return func() tea.Msg {
		_ = markRead(token, chatID, messageID)
		return nil
	}
}
