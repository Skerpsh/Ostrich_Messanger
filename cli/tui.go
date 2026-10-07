package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/gorilla/websocket"
)

const (
	reconnectDelay = 3 * time.Second
	scrollStep     = 5
)

type authSuccessMsg struct {
	result *LoginResponse
}

type authErrorMsg struct {
	err error
}

type chatsLoadedMsg struct {
	chats []Chat
}

type chatsErrorMsg struct {
	err error
}

// historyLoadedMsg carries a chat's history. open is true when the chat is
// being opened, false for a reload after (re)joining it.
type historyLoadedMsg struct {
	chat     Chat
	messages []Message
	open     bool

	// The messages reach back to the start of the chat.
	complete bool
}

type historyErrorMsg struct {
	chat Chat
	err  error
	open bool
}

type chatCreatedMsg struct {
	chat Chat
}

type chatCreateErrorMsg struct {
	err error
}

// Connection attempts carry the generation they were started for, so
// results of attempts from a previous session are dropped.
type wsConnectedMsg struct {
	gen  int
	conn *websocket.Conn
}

type wsConnectErrorMsg struct {
	gen int
	err error
}

// Websocket events carry the connection they were read from, so events
// from a connection that has already been replaced can be dropped.
type wsMessageMsg struct {
	conn    *websocket.Conn
	message WSMessage
}

type wsErrorMsg struct {
	conn *websocket.Conn
	err  error
}

// Redraws relative times ("last seen 5 min ago").
type minuteTickMsg struct{}

type tuiStage int

const (
	stageLogin tuiStage = iota
	stageChats
	stageChat
	stageSettings
	// Showing a new OstrichID that must be saved before going on.
	stageOstrichID
)

type authMode int

const (
	authLogin authMode = iota
	authRegister
)

type connStatus int

const (
	connOffline connStatus = iota
	connConnecting
	connOnline
)

type tuiModel struct {
	width  int
	height int
	stage  tuiStage

	authMode authMode

	username        textinput.Model
	password        textinput.Model
	confirmPassword textinput.Model
	ostrichIDInput  textinput.Model
	focus           int

	// Ctrl+C was pressed once on the OstrichID screen; a second press quits.
	quitArmed bool

	loading bool
	err     error

	// Success message, e.g. "Password changed".
	notice string

	user *LoginResponse

	chats    []Chat
	selected int

	// "New chat" prompt on the chats screen.
	creatingChat      bool
	chatUsernameInput textinput.Model

	// ID of the chat being opened; results for any other chat are stale
	// and get discarded.
	pendingChatID string

	currentChat  Chat
	messages     []Message
	messageInput textinput.Model

	// Number of newest messages scrolled out of view; 0 follows the latest.
	messageScroll int

	// Replies (see replies.go): selecting a message, and the message the
	// next one replies to.
	selecting       bool
	selectedMessage int
	replyTo         *Message

	// "typing…" of the other member, by chat (see events.go).
	typingUntil map[string]time.Time

	// The session's websocket, open for as long as the user is logged in.
	conn       *websocket.Conn
	connStatus connStatus
	connGen    int

	// Presence of other users by user ID.
	presence map[string]presence

	// Contacts' public keys as first seen on this computer, and the users
	// whose key has changed since (see knownkeys.go).
	knownKeys  map[string]string
	keyChanged map[string]bool

	// The safety code of the open chat is shown instead of its messages.
	safetyOpen bool

	// Settings screen.
	settingsInputs   [settingsFields]textinput.Model
	settingsFocus    int
	confirmLogoutAll bool
}

func newLoginModel() tuiModel {
	username := textinput.New()
	username.Placeholder = "Username"
	username.CharLimit = 32
	username.Width = 40
	username.Focus()

	password := textinput.New()
	password.Placeholder = "Password"
	password.CharLimit = 128
	password.Width = 40
	password.EchoMode = textinput.EchoPassword
	password.EchoCharacter = '•'

	confirmPassword := textinput.New()
	confirmPassword.Placeholder = "Confirm password"
	confirmPassword.CharLimit = 128
	confirmPassword.Width = 40
	confirmPassword.EchoMode = textinput.EchoPassword
	confirmPassword.EchoCharacter = '•'

	messageInput := textinput.New()
	messageInput.Placeholder = "Type a message..."
	messageInput.CharLimit = 4096
	messageInput.Width = 60

	ostrichIDInput := textinput.New()
	ostrichIDInput.Placeholder = "XXXX-XXXX-XXXX-XXXX-XXXX"
	ostrichIDInput.CharLimit = 40
	ostrichIDInput.Width = 40
	ostrichIDInput.EchoMode = textinput.EchoPassword
	ostrichIDInput.EchoCharacter = '•'

	chatUsernameInput := textinput.New()
	chatUsernameInput.Placeholder = "@username"
	chatUsernameInput.CharLimit = 33
	chatUsernameInput.Width = 34

	return tuiModel{
		stage:             stageLogin,
		authMode:          authLogin,
		username:          username,
		password:          password,
		confirmPassword:   confirmPassword,
		ostrichIDInput:    ostrichIDInput,
		focus:             0,
		messageInput:      messageInput,
		chatUsernameInput: chatUsernameInput,
		presence:          map[string]presence{},
		settingsInputs:    newSettingsInputs(),
	}
}

// sanitize removes terminal control characters (escape sequences, bidi
// controls) from server-provided text, including error messages, so that
// other users or a malicious server cannot mess with the terminal.
// Newlines are kept, tabs become spaces.
func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r == '\t':
			return ' '
		case unicode.IsControl(r),
			r >= '\u202a' && r <= '\u202e',
			r >= '\u2066' && r <= '\u2069',
			r == '\u200e', r == '\u200f', r == '\u061c':
			return -1
		}

		return r
	}, s)
}

func createChatCmd(token, username string) tea.Cmd {
	return func() tea.Msg {
		chat, err := createChat(token, username)

		if err != nil {
			return chatCreateErrorMsg{err: err}
		}

		return chatCreatedMsg{chat: chat}
	}
}

func loadChatsCmd(token string) tea.Cmd {
	return func() tea.Msg {
		chats, err := getChats(token)

		if err != nil {
			return chatsErrorMsg{err: err}
		}

		return chatsLoadedMsg{chats: chats}
	}
}

func loadHistoryCmd(token string, chat Chat, open bool) tea.Cmd {
	return func() tea.Msg {
		history, err := getMessages(token, chat.ID)

		if err != nil {
			return historyErrorMsg{chat: chat, err: err, open: open}
		}

		return historyLoadedMsg{
			chat:     chat,
			messages: history.Messages,
			open:     open,
			complete: !history.HasMore,
		}
	}
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

func listenTUIWebSocket(conn *websocket.Conn) tea.Cmd {
	return func() tea.Msg {
		var message WSMessage

		if err := conn.ReadJSON(&message); err != nil {
			return wsErrorMsg{conn: conn, err: err}
		}

		return wsMessageMsg{conn: conn, message: message}
	}
}

func minuteTick() tea.Cmd {
	return tea.Tick(time.Minute, func(time.Time) tea.Msg {
		return minuteTickMsg{}
	})
}

// closeConnection closes the session's websocket and cancels pending
// connection attempts.
func (m *tuiModel) closeConnection() {
	m.connGen++

	if m.conn != nil {
		m.conn.Close()
		m.conn = nil
	}

	m.connStatus = connOffline
}

// quit ends the session on the server and exits.
func (m tuiModel) quit() (tea.Model, tea.Cmd) {
	m.closeConnection()

	if m.user == nil {
		return m, tea.Quit
	}

	token := m.user.Token

	return m, tea.Sequence(
		func() tea.Msg {
			_ = logout(token)
			return nil
		},
		tea.Quit,
	)
}

// sessionExpired returns to the login screen.
func (m tuiModel) sessionExpired() (tea.Model, tea.Cmd) {
	return m.signedOut(errSessionExpired, "")
}

// signedOut drops the session and returns to the login screen, showing
// err or notice there.
func (m tuiModel) signedOut(err error, notice string) (tea.Model, tea.Cmd) {
	m.closeConnection()

	m.messageInput.Blur()
	m.chatUsernameInput.Blur()
	m.settingsInputs = newSettingsInputs()
	m.confirmLogoutAll = false
	m.creatingChat = false
	m.pendingChatID = ""
	m.loading = false
	m.user = nil
	m.chats = nil
	m.messages = nil
	m.presence = map[string]presence{}
	m.knownKeys = nil
	m.keyChanged = nil
	m.safetyOpen = false
	clearChatKeys()
	m.stage = stageLogin
	m.authMode = authLogin
	m.password.SetValue("")
	m.confirmPassword.SetValue("")
	m.ostrichIDInput.SetValue("")
	m.quitArmed = false
	m.focus = 0
	m.moveFocus(0)
	m.err = err
	m.notice = notice

	return m, nil
}

func (m *tuiModel) setPresence(userID string, online bool, lastSeenAt *string) {
	m.presence[userID] = presence{online: online, lastSeen: parseTime(lastSeenAt)}
}

// openChat joins the chat and loads its history.
func (m tuiModel) openChat(chat Chat) (tea.Model, tea.Cmd) {
	m.loading = true
	m.err = nil
	m.pendingChatID = chat.ID

	// Without a connection the chat is joined once it is reconnected.
	if m.conn != nil {
		_ = joinChat(m.conn, chat.ID)
	}

	return m, loadHistoryCmd(m.user.Token, chat, true)
}

// leaveChatIfConnected stops receiving a chat's messages.
func (m tuiModel) leaveChatIfConnected(chatID string) {
	if m.conn != nil {
		_ = leaveChat(m.conn, chatID)
	}
}

// mergeMessages adds messages that are not there yet, keeping the order
// by creation time.
func (m *tuiModel) mergeMessages(messages []Message) {
	added := false

	for _, message := range messages {
		if !m.hasMessage(message.ID) {
			m.messages = append(m.messages, message)
			added = true

			// Keep a scrolled-up view in place.
			if m.messageScroll > 0 {
				m.messageScroll++
			}
		}
	}

	if added {
		sort.SliceStable(m.messages, func(i, j int) bool {
			return m.messages[i].CreatedAt < m.messages[j].CreatedAt
		})
	}
}

func (m tuiModel) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, minuteTick())
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.messageScroll = min(m.messageScroll, m.maxMessageScroll())

	case minuteTickMsg:
		return m, minuteTick()

	case typingExpiredMsg:
		// Redraw so "typing…" disappears.
		return m, nil

	case authSuccessMsg:
		m.loading = true
		m.user = msg.result
		m.err = nil
		m.presence = map[string]presence{}
		m.knownKeys = loadKnownKeys(msg.result.User.ID)
		m.keyChanged = map[string]bool{}
		m.password.SetValue("")
		m.confirmPassword.SetValue("")
		m.ostrichIDInput.SetValue("")

		m.closeConnection()
		m.connStatus = connConnecting

		// A new OstrichID: show it first. Chats load in the background
		// (they switch the screen only from the login stage).
		if msg.result.OstrichID != "" {
			m.loading = false
			m.stage = stageOstrichID
		}

		return m, tea.Batch(
			loadChatsCmd(msg.result.Token),
			connectCmd(msg.result.Token, m.connGen, 0),
		)

	case authErrorMsg:
		m.loading = false
		m.err = msg.err

		return m, nil

	case chatsLoadedMsg:
		// Keep the cursor on the same chat after a refresh.
		selectedID := ""

		if m.selected < len(m.chats) {
			selectedID = m.chats[m.selected].ID
		}

		m.chats = msg.chats
		m.selected = 0

		for i, chat := range m.chats {
			if chat.ID == selectedID {
				m.selected = i
			}

			m.setPresence(chat.UserID, chat.Online, chat.LastSeenAt)

			// The open chat may have changed (blocked, new key).
			if m.stage == stageChat && chat.ID == m.currentChat.ID {
				m.currentChat = chat
			}
		}

		m.checkPeerKeys()

		if m.stage == stageLogin {
			m.loading = false
			m.stage = stageChats
			m.err = nil
		}

		return m, nil

	case chatsErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		if m.stage == stageLogin {
			// Logged in, but the chats could not be loaded.
			m.loading = false
			m.user = nil
			m.closeConnection()
		}

		m.err = msg.err

		return m, nil

	case chatCreatedMsg:
		m.creatingChat = false
		m.chatUsernameInput.Blur()
		m.chatUsernameInput.SetValue("")
		m.setPresence(msg.chat.UserID, msg.chat.Online, msg.chat.LastSeenAt)

		// Open the chat right away and refresh the list in the background.
		model, cmd := m.openChat(msg.chat)

		return model, tea.Batch(cmd, loadChatsCmd(m.user.Token))

	case chatCreateErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		m.loading = false
		m.err = msg.err

		return m, nil

	case historyLoadedMsg:
		if !msg.open {
			// Reload after (re)joining: add what was missed, drop what was
			// deleted meanwhile.
			if m.stage == stageChat && m.currentChat.ID == msg.chat.ID {
				m.reconcileMessages(msg.messages, msg.complete)

				return m, m.markChatRead(msg.chat.ID, msg.messages)
			}

			return m, nil
		}

		if msg.chat.ID != m.pendingChatID {
			// The user left before the chat finished opening.
			if m.stage != stageChat || m.currentChat.ID != msg.chat.ID {
				m.leaveChatIfConnected(msg.chat.ID)
			}

			return m, nil
		}

		m.pendingChatID = ""
		m.loading = false
		m.currentChat = msg.chat
		m.messages = nil
		m.messageScroll = 0
		m.resetReply()
		m.mergeMessages(msg.messages)
		m.stage = stageChat
		m.err = nil

		m.messageInput.SetValue("")
		m.messageInput.Focus()

		return m, m.markChatRead(msg.chat.ID, msg.messages)

	case historyErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		if msg.open {
			if msg.chat.ID != m.pendingChatID {
				return m, nil
			}

			m.leaveChatIfConnected(msg.chat.ID)
			m.pendingChatID = ""
			m.loading = false
		}

		m.err = msg.err

		return m, nil

	case usernameChangedMsg, usernameChangeErrorMsg,
		passwordChangedMsg, passwordChangeErrorMsg,
		loggedOutAllMsg, logoutAllErrorMsg:
		return m.updateSettingsResult(msg)

	case wsConnectedMsg:
		if msg.gen != m.connGen || m.user == nil || m.conn != nil {
			msg.conn.Close()
			return m, nil
		}

		m.conn = msg.conn
		m.connStatus = connOnline

		// Re-join what is open; the "joined" answer reloads missed history.
		if m.stage == stageChat {
			_ = joinChat(m.conn, m.currentChat.ID)
		}

		if m.pendingChatID != "" {
			_ = joinChat(m.conn, m.pendingChatID)
		}

		return m, tea.Batch(
			listenTUIWebSocket(m.conn),
			// Presence may have changed while disconnected.
			loadChatsCmd(m.user.Token),
		)

	case wsConnectErrorMsg:
		if msg.gen != m.connGen || m.user == nil {
			return m, nil
		}

		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		m.connStatus = connConnecting

		return m, connectCmd(m.user.Token, m.connGen, reconnectDelay)

	case wsMessageMsg:
		if msg.conn != m.conn {
			// Connection was closed on purpose; nothing to listen to.
			return m, nil
		}

		var cmd tea.Cmd

		switch msg.message.Type {
		case "joined":
			if m.stage == stageChat && msg.message.ChatID == m.currentChat.ID {
				cmd = loadHistoryCmd(m.user.Token, m.currentChat, false)
			}

		case "message":
			// Messages of all chats arrive, not only the open one.
			message := msg.message.Message

			if message == nil {
				break
			}

			viewing := m.stage == stageChat && message.ChatID == m.currentChat.ID

			if viewing {
				m.mergeMessages([]Message{*message})
				cmd = m.markChatRead(message.ChatID, []Message{*message})
			}

			if !m.chatMessageArrived(*message, viewing) {
				// A chat someone has just started.
				cmd = tea.Batch(cmd, loadChatsCmd(m.user.Token))
			}

			// The message ends "typing…".
			delete(m.typingUntil, message.ChatID)

		case "typing", "message_updated", "message_deleted", "reactions",
			"chat_deleted", "chats_changed":
			cmd = m.handleChatEvent(msg.message)

		case "read":
			// Read on another device of this user.
			if msg.message.UserID == m.user.User.ID {
				m.chatReadElsewhere(msg.message.ChatID, msg.message.LastReadAt)
			}

		case "presence":
			if msg.message.UserID != "" {
				m.setPresence(
					msg.message.UserID,
					msg.message.Online,
					msg.message.LastSeenAt,
				)
			}

		case "error":
			m.err = fmt.Errorf(
				"server error: %s",
				msg.message.Error,
			)
		}

		return m, tea.Batch(cmd, listenTUIWebSocket(m.conn))

	case wsErrorMsg:
		if msg.conn != m.conn {
			// Connection was closed on purpose or replaced.
			return m, nil
		}

		m.conn.Close()
		m.conn = nil
		m.connStatus = connConnecting

		return m, connectCmd(m.user.Token, m.connGen, reconnectDelay)

	case tea.KeyMsg:

		if msg.String() == "ctrl+c" {
			// Quitting loses the OstrichID for good: ask once more.
			if m.stage == stageOstrichID && !m.quitArmed {
				m.quitArmed = true
				return m, nil
			}

			return m.quit()
		}

		switch m.stage {
		case stageLogin:
			return m.updateLogin(msg)

		case stageChats:
			return m.updateChats(msg)

		case stageChat:
			return m.updateChat(msg)

		case stageSettings:
			return m.updateSettings(msg)

		case stageOstrichID:
			return m.updateOstrichID(msg)
		}
	}

	return m, nil
}

func (m tuiModel) hasMessage(id string) bool {
	if id == "" {
		return false
	}

	for i := len(m.messages) - 1; i >= 0; i-- {
		if m.messages[i].ID == id {
			return true
		}
	}

	return false
}
