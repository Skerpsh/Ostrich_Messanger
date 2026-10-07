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
	"github.com/charmbracelet/lipgloss"
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

	// Settings screen.
	settingsInputs   [settingsFields]textinput.Model
	settingsFocus    int
	confirmLogoutAll bool
}

var (
	logoStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("205")).
			MarginBottom(1)

	inputStyle = lipgloss.NewStyle().
			Width(40).
			Padding(0, 1)

	labelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("245"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("9"))

	successStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("10"))

	hintStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("241"))

	onlineStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("10"))

	selectedChatStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("205"))

	chatBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1, 2)

	messageBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1, 2)

	ownMessageStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("10"))

	otherMessageStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("205"))
)

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
		messages, err := getMessages(token, chat.ID)

		if err != nil {
			return historyErrorMsg{chat: chat, err: err, open: open}
		}

		return historyLoadedMsg{chat: chat, messages: messages, open: open}
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
		}

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
			// Reload after (re)joining: add what was missed.
			if m.stage == stageChat && m.currentChat.ID == msg.chat.ID {
				m.mergeMessages(msg.messages)

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

// moveFocus moves the login form focus by delta fields, wrapping around.
func (m *tuiModel) moveFocus(delta int) {
	// Login: username, password, OstrichID.
	// Register: username, password, confirm password.
	const fields = 3

	m.focus = ((m.focus+delta)%fields + fields) % fields

	m.username.Blur()
	m.password.Blur()
	m.confirmPassword.Blur()
	m.ostrichIDInput.Blur()

	switch m.focus {
	case 0:
		m.username.Focus()

	case 1:
		m.password.Focus()

	case 2:
		if m.authMode == authRegister {
			m.confirmPassword.Focus()
		} else {
			m.ostrichIDInput.Focus()
		}
	}
}

func (m tuiModel) updateLogin(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.loading {
		return m, nil
	}

	switch msg.String() {

	case "esc":
		if m.authMode == authRegister {
			m.authMode = authLogin
			m.focus = 0
			m.err = nil
			m.moveFocus(0)

			return m, nil
		}

		return m, tea.Quit

	// Tab / Shift+Tab переключают Login <-> Register
	case "tab", "shift+tab":
		if m.authMode == authLogin {
			m.authMode = authRegister
		} else {
			m.authMode = authLogin
		}

		m.focus = 0
		m.err = nil
		m.moveFocus(0)

		return m, nil

	// Стрелки переключают поля
	case "up":
		m.moveFocus(-1)

		return m, nil

	case "down":
		m.moveFocus(1)

		return m, nil

	case "enter":
		// "@alice" works too.
		username := strings.TrimPrefix(strings.TrimSpace(m.username.Value()), "@")
		password := m.password.Value()

		if username == "" {
			m.err = fmt.Errorf("username is required")
			return m, nil
		}

		if password == "" {
			m.err = fmt.Errorf("password is required")
			return m, nil
		}

		ostrichID := strings.TrimSpace(m.ostrichIDInput.Value())

		auth := func() (*LoginResponse, error) {
			return loginWithCredentials(username, password, ostrichID)
		}

		if m.authMode == authRegister {
			confirmPassword := m.confirmPassword.Value()

			if confirmPassword == "" {
				m.err = fmt.Errorf("please confirm your password")
				return m, nil
			}

			if password != confirmPassword {
				m.err = fmt.Errorf("passwords do not match")
				return m, nil
			}

			auth = func() (*LoginResponse, error) {
				return registerWithCredentials(username, password)
			}
		}

		m.loading = true
		m.user = nil
		m.err = nil
		m.notice = ""

		return m, func() tea.Msg {
			result, err := auth()

			if err != nil {
				return authErrorMsg{err: err}
			}

			return authSuccessMsg{result: result}
		}
	}

	var cmd tea.Cmd

	switch m.focus {

	case 0:
		m.username, cmd = m.username.Update(msg)

	case 1:
		m.password, cmd = m.password.Update(msg)

	case 2:
		if m.authMode == authRegister {
			m.confirmPassword, cmd = m.confirmPassword.Update(msg)
		} else {
			m.ostrichIDInput, cmd = m.ostrichIDInput.Update(msg)
		}
	}

	return m, cmd
}

func (m tuiModel) updateChats(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.loading {
		return m, nil
	}

	if m.creatingChat {
		return m.updateNewChat(msg)
	}

	switch msg.String() {

	case "q":
		return m.quit()

	case "n":
		m.creatingChat = true
		m.err = nil
		m.chatUsernameInput.SetValue("")

		return m, m.chatUsernameInput.Focus()

	case "r":
		m.err = nil

		return m, loadChatsCmd(m.user.Token)

	case "s":
		return m.openSettings()

	case "up", "k":
		if m.selected > 0 {
			m.selected--
		}

	case "down", "j":
		if m.selected < len(m.chats)-1 {
			m.selected++
		}

	case "enter":
		if len(m.chats) == 0 {
			return m, nil
		}

		return m.openChat(m.chats[m.selected])
	}

	return m, nil
}

func (m tuiModel) updateNewChat(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {

	case "esc":
		m.creatingChat = false
		m.chatUsernameInput.Blur()
		m.err = nil

		return m, nil

	case "enter":
		// "@alice" and "alice" both work.
		username := strings.TrimPrefix(
			strings.TrimSpace(m.chatUsernameInput.Value()),
			"@",
		)

		if !validUsername(username) {
			m.err = errInvalidUsername
			return m, nil
		}

		if strings.EqualFold(username, m.user.User.Username) {
			m.err = fmt.Errorf("this is your own username")
			return m, nil
		}

		m.loading = true
		m.err = nil

		return m, createChatCmd(m.user.Token, username)
	}

	var cmd tea.Cmd

	m.chatUsernameInput, cmd = m.chatUsernameInput.Update(msg)

	return m, cmd
}

func (m tuiModel) updateChat(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.selecting {
		return m.updateSelecting(msg)
	}

	switch msg.String() {

	case "up":
		// With an empty input, ↑ picks a message to reply to.
		if m.messageInput.Value() == "" && len(m.messages) > 0 {
			m.selecting = true
			m.selectedMessage = len(m.messages) - 1
			m.keepSelectionVisible()
			m.messageInput.Blur()

			return m, nil
		}

	case "esc":
		if m.replyTo != nil {
			m.replyTo = nil

			return m, nil
		}

		// The connection stays open (keeps the user online); only stop
		// receiving this chat's messages.
		m.leaveChatIfConnected(m.currentChat.ID)

		m.messageInput.Blur()
		m.stage = stageChats
		m.err = nil
		m.messageScroll = 0
		m.resetReply()

		// Chat order may have changed while the chat was open.
		return m, loadChatsCmd(m.user.Token)

	case "pgup":
		m.messageScroll = min(m.messageScroll+scrollStep, m.maxMessageScroll())

		return m, nil

	case "pgdown":
		m.messageScroll = max(m.messageScroll-scrollStep, 0)

		return m, nil

	case "home":
		m.messageScroll = m.maxMessageScroll()

		return m, nil

	case "end":
		m.messageScroll = 0

		return m, nil

	case "enter":
		content := strings.TrimSpace(
			m.messageInput.Value(),
		)

		if content == "" {
			return m, nil
		}

		if m.conn == nil {
			m.err = fmt.Errorf("not connected, reconnecting...")
			return m, nil
		}

		// The server only takes end-to-end encrypted messages.
		encrypted, err := encryptMessage(content, m.user.PrivateKey, m.currentChat.PublicKey, m.currentChat.ID)
		if err != nil {
			m.err = err
			return m, nil
		}

		payload := map[string]string{
			"type":    "message",
			"chatId":  m.currentChat.ID,
			"content": encrypted,
		}

		if m.replyTo != nil {
			payload["replyTo"] = m.replyTo.ID
		}

		err = writeWebSocketJSON(m.conn, payload)

		if err != nil {
			m.err = err
			return m, nil
		}

		m.replyTo = nil
		m.messageInput.SetValue("")
		m.messageScroll = 0

		return m, nil
	}

	var cmd tea.Cmd

	m.messageInput, cmd = m.messageInput.Update(msg)

	return m, cmd
}

func (m tuiModel) View() string {
	switch m.stage {

	case stageLogin:
		return m.loginView()

	case stageChats:
		return m.chatsView()

	case stageChat:
		return m.chatView()

	case stageSettings:
		return m.settingsView()

	case stageOstrichID:
		return m.ostrichIDView()
	}

	return ""
}

func (m tuiModel) loginView() string {
	var b strings.Builder

	b.WriteString("\n")

	b.WriteString(
		logoStyle.Render(
			"╔════════════════════╗\n" +
				"║    OSTRICH CLI     ║\n" +
				"╚════════════════════╝",
		),
	)

	b.WriteString("\n\n")

	if m.loading && m.user != nil {
		action := "Logged in"

		if m.authMode == authRegister {
			action = "Account created"
		}

		b.WriteString(
			successStyle.Render(
				"✓ " + action + " as " + m.user.User.Username,
			),
		)

		b.WriteString("\n\n")
		b.WriteString("Loading chats...")
		b.WriteString("\n")

		return b.String()
	}

	/*
		Authentication mode selector.
	*/

	loginLabel := "Login"
	registerLabel := "Register"

	if m.authMode == authLogin {
		loginLabel = "▶ Login"
	} else {
		registerLabel = "▶ Register"
	}

	if m.authMode == authLogin {
		b.WriteString(
			selectedChatStyle.Render(loginLabel),
		)
	} else {
		b.WriteString(loginLabel)
	}

	b.WriteString("    ")

	if m.authMode == authRegister {
		b.WriteString(
			selectedChatStyle.Render(registerLabel),
		)
	} else {
		b.WriteString(registerLabel)
	}

	b.WriteString("\n\n")

	b.WriteString(labelStyle.Render("Username"))
	b.WriteString("\n")
	b.WriteString(inputStyle.Render(m.username.View()))
	b.WriteString("\n\n")

	b.WriteString(labelStyle.Render("Password"))
	b.WriteString("\n")
	b.WriteString(inputStyle.Render(m.password.View()))
	b.WriteString("\n")

	if m.authMode == authLogin {
		b.WriteString("\n")
		b.WriteString(labelStyle.Render("OstrichID"))
		b.WriteString("\n")
		b.WriteString(inputStyle.Render(m.ostrichIDInput.View()))
		b.WriteString("\n")
	}

	if m.authMode == authRegister {
		b.WriteString("\n")
		b.WriteString(hintStyle.Render(
			"After registration you get an OstrichID: you need it to log in and it\n" +
				"is the key to your end-to-end encrypted messages. It is shown only once.",
		))
		b.WriteString("\n\n")

		b.WriteString(
			labelStyle.Render("Confirm password"),
		)

		b.WriteString("\n")

		b.WriteString(
			inputStyle.Render(
				m.confirmPassword.View(),
			),
		)

		b.WriteString("\n")
	}

	b.WriteString("\n")

	if m.loading {
		if m.authMode == authRegister {
			b.WriteString("Creating account...\n")
		} else {
			b.WriteString("Connecting to Ostrich...\n")
		}
	} else {
		if m.authMode == authRegister {
			b.WriteString(
				hintStyle.Render(
					"Tab Login mode   ↑↓ Field   Enter Register   Esc Back   Ctrl+C Quit",
				),
			)
		} else {
			b.WriteString(
				hintStyle.Render(
					"Tab Register mode   ↑↓ Field   Enter Login   Esc Quit   Ctrl+C Quit",
				),
			)
		}

		b.WriteString("\n")
	}

	if m.notice != "" {
		b.WriteString("\n")
		b.WriteString(successStyle.Render("✓ " + m.notice))
		b.WriteString("\n")
	}

	if m.err != nil {
		b.WriteString("\n")

		b.WriteString(
			errorStyle.Render(
				"Error: " + sanitize(m.err.Error()),
			),
		)

		b.WriteString("\n")
	}

	return b.String()
}

// presenceText renders a user's presence: a green "● online" or a grey
// "last seen ...".
func (m tuiModel) presenceText(userID string) string {
	p, ok := m.presence[userID]

	if !ok {
		return ""
	}

	text := formatPresence(&p, time.Now())

	if p.online {
		return onlineStyle.Render("● " + text)
	}

	return hintStyle.Render(text)
}

func (m tuiModel) chatsView() string {
	var b strings.Builder

	b.WriteString("\n")

	title := "OSTRICH"

	if m.user != nil {
		title += "   @" + sanitize(m.user.User.Username)
	}

	b.WriteString(logoStyle.Render(title))

	if m.user != nil && m.user.User.IsDeveloper {
		b.WriteString(" " + devBadge())
	}

	if m.connStatus != connOnline {
		b.WriteString("   " + hintStyle.Render("connecting..."))
	}

	if m.user != nil {
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Share your @" + sanitize(m.user.User.Username) + " to start a chat"))
	}

	b.WriteString("\n\n")

	var chatList strings.Builder

	chatList.WriteString("Chats\n\n")

	if len(m.chats) == 0 {
		chatList.WriteString("No chats.\nPress n to start one.")
	} else {
		start, end := m.chatListWindow()

		if start > 0 {
			chatList.WriteString(hintStyle.Render(fmt.Sprintf("↑ %d more", start)))
			chatList.WriteString("\n\n")
		}

		for i := start; i < end; i++ {
			chat := m.chats[i]
			cursor := "  "

			if i == m.selected {
				cursor = "▶ "
			}

			name := cursor + sanitize(chat.Username)

			if i == m.selected {
				name = selectedChatStyle.Render(name)
			}

			name = withDevBadge(name, chat.IsDeveloper)

			if chat.Pinned {
				name += hintStyle.Render("  pinned")
			}

			if chat.Muted {
				name += hintStyle.Render("  muted")
			}

			if chat.UnreadCount > 0 {
				name += " " + unreadStyle.Render(fmt.Sprintf(" %d ", chat.UnreadCount))
			}

			chatList.WriteString(name + "\n  " + m.chatPreview(chat))

			if status := m.presenceText(chat.UserID); status != "" {
				chatList.WriteString("  " + status)
			}

			if i < end-1 {
				chatList.WriteString("\n\n")
			}
		}

		if end < len(m.chats) {
			chatList.WriteString("\n\n")
			chatList.WriteString(hintStyle.Render(fmt.Sprintf("↓ %d more", len(m.chats)-end)))
		}
	}

	left := chatBoxStyle.Render(
		chatList.String(),
	)

	rightText := "Select a chat\n\n" +
		"↑ / ↓   Navigate\n" +
		"Enter   Open chat\n" +
		"n       New chat\n" +
		"r       Refresh\n" +
		"s       Settings\n" +
		"q       Quit"

	if m.creatingChat {
		rightText = "New chat\n\n" +
			"Enter the exact @username of the user:\n\n" +
			m.chatUsernameInput.View()

		if m.loading {
			rightText += "\n\nCreating chat..."
		}
	} else if m.loading {
		rightText = "Opening chat..."
	}

	right := messageBoxStyle.Render(
		rightText,
	)

	content := lipgloss.JoinHorizontal(
		lipgloss.Top,
		left,
		right,
	)

	b.WriteString(content)
	b.WriteString("\n\n")

	hint := "↑↓ / j k Navigate   Enter Open   n New chat   r Refresh   s Settings   q / Ctrl+C Quit"

	if m.creatingChat {
		hint = "Enter Create   Esc Cancel   Ctrl+C Quit"
	}

	b.WriteString(hintStyle.Render(hint))

	b.WriteString("\n")

	if m.err != nil {
		b.WriteString(
			errorStyle.Render(
				"Error: " + sanitize(m.err.Error()),
			),
		)

		b.WriteString("\n")
	}

	return b.String()
}

// chatListWindow returns the range of chats that fits on screen, keeping
// the selected chat visible.
func (m tuiModel) chatListWindow() (start, end int) {
	height := m.height

	if height == 0 {
		height = 24
	}

	// Everything except the list itself: header (4 lines), box border and
	// padding (4), "Chats" title (2), "more" markers (4), hints and error (4).
	// Each chat takes 3 lines (name, @username, blank line).
	visible := max((height-18)/3, 1)

	start = max(m.selected-visible+1, 0)
	end = min(start+visible, len(m.chats))

	return start, end
}

// chatWidths returns the width of the chat boxes (including padding) and
// of the message text inside them.
func (m tuiModel) chatWidths() (boxWidth, textWidth int) {
	boxWidth = max(m.width-4, 40)

	return boxWidth, boxWidth - 4
}

// chatFooter renders everything below the message box.
func (m tuiModel) chatFooter(boxWidth int) string {
	input := m.messageInput
	// Box padding (2), prompt "> " (2) and cursor (1).
	input.Width = max(boxWidth-5, 10)

	footer := lipgloss.NewStyle().
		Width(boxWidth).
		Border(lipgloss.RoundedBorder()).
		Padding(0, 1).
		Render(input.View())

	if bar := m.replyBar(); bar != "" {
		footer = lipgloss.NewStyle().Width(boxWidth+2).Render(bar) + "\n" + footer
	}

	hint := "Enter Send   ↑ Reply to a message   PgUp/PgDown Scroll   Home/End Jump   Esc Back   Ctrl+C Quit"

	if m.selecting {
		hint = "↑↓ Select a message   Enter / r Reply   Esc Cancel"
	}

	footer += "\n\n" + hintStyle.Width(boxWidth+2).Render(hint)

	if m.err != nil {
		footer += "\n" + errorStyle.
			Width(boxWidth+2).
			Render("Error: "+sanitize(m.err.Error()))
	}

	return footer
}

// messageAreaHeight returns how many lines of messages fit on screen.
func (m tuiModel) messageAreaHeight() int {
	height := m.height

	if height == 0 {
		height = 24
	}

	boxWidth, _ := m.chatWidths()

	// Blank line, header, blank line, message box border and padding (4),
	// blank line, footer.
	used := 1 + 1 + 1 + 4 + 1 + lipgloss.Height(m.chatFooter(boxWidth))

	return max(height-used, 1)
}

func (m tuiModel) renderMessages(textWidth int) []string {
	rendered := make([]string, len(m.messages))

	for i, message := range m.messages {
		isOwn := m.user != nil && message.SenderID == m.user.User.ID

		name := message.SenderUsername

		if name == "" {
			if isOwn {
				name = m.user.User.Username
			} else {
				name = m.currentChat.Username
			}
		}

		style := otherMessageStyle.
			Width(textWidth).
			Align(lipgloss.Left)

		if isOwn {
			style = ownMessageStyle.
				Width(textWidth).
				Align(lipgloss.Right)
		}

		text := sanitize(name) + ": " + sanitize(m.textOf(m.currentChat, message.Content))

		if m.selecting && i == m.selectedMessage {
			text = selectedChatStyle.Render("▶ ") + text
		}

		if message.EditedAt != nil {
			text += hintStyle.Render(" (edited)")
		}

		if message.ReplyTo != nil {
			text = m.quoteLine(message.ReplyTo) + "\n" + text
		}

		if line := reactionsLine(message.Reactions); line != "" {
			text += "\n" + line
		}

		rendered[i] = style.Render(text)
	}

	return rendered
}

// messageCost is the number of lines a message takes, counting the blank
// line that separates it from the previous one.
func messageCost(rendered string, first bool) int {
	if first {
		return lipgloss.Height(rendered)
	}

	return lipgloss.Height(rendered) + 1
}

// messageWindow returns the range of messages that fits into area lines
// when the newest scroll messages are scrolled out of view.
func messageWindow(rendered []string, area, scroll int) (start, end int) {
	end = len(rendered) - min(scroll, len(rendered))
	start = end
	used := 0

	for start > 0 {
		cost := messageCost(rendered[start-1], start == end)

		// Always show at least one message, even if it is taller than area.
		if used+cost > area && start < end {
			break
		}

		used += cost
		start--
	}

	return start, end
}

// maxScroll returns the scroll value at which the oldest message is at
// the top of the message area.
func maxScroll(rendered []string, area int) int {
	used, fit := 0, 0

	for fit < len(rendered) {
		cost := messageCost(rendered[fit], fit == 0)

		if used+cost > area && fit > 0 {
			break
		}

		used += cost
		fit++
	}

	return len(rendered) - fit
}

func (m tuiModel) maxMessageScroll() int {
	_, textWidth := m.chatWidths()

	return maxScroll(m.renderMessages(textWidth), m.messageAreaHeight())
}

func (m tuiModel) chatView() string {
	boxWidth, textWidth := m.chatWidths()
	area := m.messageAreaHeight()
	rendered := m.renderMessages(textWidth)

	scroll := min(m.messageScroll, maxScroll(rendered, area))
	start, end := messageWindow(rendered, area, scroll)

	var content string

	if len(rendered) == 0 {
		content = hintStyle.Render("No messages yet.")
	} else {
		content = strings.Join(rendered[start:end], "\n\n")

		// A single message taller than the area: show its end.
		if lines := strings.Split(content, "\n"); len(lines) > area {
			content = strings.Join(lines[len(lines)-area:], "\n")
		}
	}

	messageBox := lipgloss.NewStyle().
		Width(boxWidth).
		Height(area+2).
		Border(lipgloss.RoundedBorder()).
		Padding(1, 2).
		Render(content)

	header := logoStyle.
		UnsetMarginBottom().
		Render("OSTRICH   /   " + sanitize(m.currentChat.Username))

	header = withDevBadge(header, m.currentChat.IsDeveloper)

	var status []string

	// The peer's presence is only known while we are connected ourselves.
	if m.connStatus != connOnline {
		status = append(status, hintStyle.Render("connecting..."))
	} else if m.isTyping(m.currentChat.ID) {
		status = append(status, selectedChatStyle.Render("typing…"))
	} else if peer := m.presenceText(m.currentChat.UserID); peer != "" {
		status = append(status, peer)
	}

	if m.currentChat.BlockedByMe {
		status = append(status, errorStyle.Render("blocked"))
	}

	if start > 0 {
		status = append(status, hintStyle.Render(fmt.Sprintf("↑ %d older", start)))
	}

	if end < len(rendered) {
		status = append(status, hintStyle.Render(fmt.Sprintf("↓ %d newer", len(rendered)-end)))
	}

	if len(status) > 0 {
		header += "   " + strings.Join(status, "   ")
	}

	return "\n" + header + "\n\n" + messageBox + "\n\n" + m.chatFooter(boxWidth)
}
