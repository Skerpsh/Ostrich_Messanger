package main

import (
	"errors"
	"fmt"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gorilla/websocket"
	zone "github.com/lrstanley/bubblezone"
)

// The terminal app, laid out like the web app: the chats list on the left
// and the open chat (or Settings) on the right; on a narrow terminal one
// of them at a time.

type stage int

const (
	stageAuth stage = iota
	// A new account's OstrichID, shown once.
	stageOstrichID
	stageMain
)

// The part of the main screen that has the keyboard.
type pane int

const (
	paneList pane = iota
	paneChat
	paneSettings
)

type connStatus int

const (
	connOffline connStatus = iota
	connConnecting
	connOnline
)

// Terminals at least this wide show the chats list next to the chat.
const wideLayoutMinWidth = 96

const (
	reconnectDelay = 3 * time.Second
	toastDuration  = 4 * time.Second
	typingDuration = 6 * time.Second
	// "typing…" is sent at most this often while typing.
	typingInterval = 3 * time.Second
)

type model struct {
	width, height int

	cfg config
	// The terminal's background is dark ("system" theme).
	systemDark bool
	pal        palette

	stage stage
	auth  authState

	user *LoginResponse

	// OstrichID screen: "I have saved it" checked; Ctrl+C pressed once.
	idSaved   bool
	quitArmed bool

	// The session is kept for the next start ("Remember me"), or will be
	// once the new account's OstrichID is confirmed.
	remembered    bool
	rememberLater bool

	// Commands for the first update (a remembered session).
	initCmd tea.Cmd

	// The session's websocket, open while logged in.
	conn       *websocket.Conn
	connStatus connStatus
	connGen    int

	presence    map[string]presence
	typingUntil map[string]time.Time

	// Contacts' keys as first seen here, and users whose key has changed
	// since (knownkeys.go).
	knownKeys  map[string]string
	keyChanged map[string]bool

	chats       []Chat
	chatsLoaded bool
	list        listState

	// The open chat; nil if none.
	chat *chatState

	// Settings, when open.
	settings *settingsState

	focus pane

	// Overlays over the screen: an actions menu, the safety code.
	menu       *menuState
	safetyOpen bool

	// A short message instead of the key hints, e.g. an error.
	toast    string
	toastErr bool
	toastID  int

	// The terminal window's title (unread count).
	title string
}

// newModel starts at the login screen, or in the remembered session.
func newModel(systemDark bool, saved *LoginResponse) model {
	m := model{
		cfg:         loadConfig(),
		systemDark:  systemDark,
		presence:    map[string]presence{},
		typingUntil: map[string]time.Time{},
	}

	m.applyTheme()
	m.auth = newAuthState(m.pal)

	if saved != nil {
		m.remembered = true
		m.initCmd = tea.Batch(m.startSession(saved), m.verifySession())
	}

	return m
}

// verifySession checks a remembered session with the server: an expired
// one goes back to the login screen; offline, the CLI starts with what it
// remembered and catches up once connected.
func (m *model) verifySession() tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		account, err := getMe(token)

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			switch {
			case errors.Is(err, errSessionExpired):
				return m.signOut("Your session has ended, please log in again")
			case err != nil:
				return m.showToast("Offline: showing what was saved", true)
			}

			m.user.User = *account

			return func() tea.Msg {
				updateSavedUser(*account)
				return nil
			}
		}
	})
}

// rememberSession keeps the session for the next start.
func (m *model) rememberSession() tea.Cmd {
	result := *m.user

	return task(func() func(*model) tea.Cmd {
		inKeyring, err := saveSession(&result)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.showToast("Couldn't remember the session: "+err.Error(), true)
			}

			m.remembered = true

			if !inKeyring {
				return m.showToast("Remembered in ~/.config/ostrich (no system keyring found)", false)
			}

			return nil
		}
	})
}

// applyTheme computes the palette from the preferences and restyles the
// inputs.
func (m *model) applyTheme() {
	mode := themeDark

	switch m.cfg.Theme {
	case "light":
		mode = themeLight
	case "system":
		if !m.systemDark {
			mode = themeLight
		}
	}

	m.pal = newPalette(mode, m.cfg.Accent)
	m.auth.restyle(m.pal)
	m.list.restyle(m.pal)

	if m.chat != nil {
		m.chat.restyle(m.pal)
	}

	if m.settings != nil {
		m.settings.restyle(m.pal)
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(tea.SetWindowTitle("Ostrich"), clockTick(), m.initCmd)
}

// --- background work ---

// resultMsg carries the result of background work: apply changes the
// model with it.
type resultMsg struct {
	apply func(*model) tea.Cmd
}

// task runs work in the background; the function it returns is applied
// to the model.
func task(work func() func(*model) tea.Cmd) tea.Cmd {
	return func() tea.Msg {
		return resultMsg{apply: work()}
	}
}

type clockMsg struct{}

// clockTick redraws relative times ("last seen 5 min ago") and ends
// "typing…".
func clockTick() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return clockMsg{} })
}

type toastExpiredMsg struct{ id int }

// showToast shows a message for a few seconds instead of the key hints.
func (m *model) showToast(text string, isErr bool) tea.Cmd {
	m.toast = text
	m.toastErr = isErr
	m.toastID++
	id := m.toastID

	return tea.Tick(toastDuration, func(time.Time) tea.Msg { return toastExpiredMsg{id: id} })
}

// fail shows an error; an expired session logs out.
func (m *model) fail(err error) tea.Cmd {
	if errors.Is(err, errSessionExpired) {
		return m.signOut(errSessionExpired.Error())
	}

	return m.showToast(err.Error(), true)
}

// --- update ---

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layoutInputs()

		return m, nil

	case resultMsg:
		if msg.apply == nil {
			return m, nil
		}

		cmd := msg.apply(&m)

		return m, cmd

	case clockMsg:
		return m, clockTick()

	case toastExpiredMsg:
		if msg.id == m.toastID {
			m.toast = ""
		}

		return m, nil

	case wsConnectedMsg, wsConnectErrorMsg, wsMessageMsg, wsErrorMsg:
		cmd := m.updateRealtime(msg)

		return m, tea.Batch(cmd, m.updateTitle())

	case tea.MouseMsg:
		cmd := m.updateMouse(msg)

		return m, tea.Batch(cmd, m.updateTitle())

	case tea.KeyMsg:
		cmd := m.updateKey(msg)

		return m, tea.Batch(cmd, m.updateTitle())
	}

	return m, nil
}

func (m *model) updateKey(msg tea.KeyMsg) tea.Cmd {
	if msg.String() == "ctrl+c" {
		// Quitting loses a new OstrichID for good: ask once more.
		if m.stage == stageOstrichID && !m.quitArmed {
			m.quitArmed = true
			return nil
		}

		return m.quit()
	}

	switch m.stage {
	case stageAuth:
		return m.updateAuthKey(msg)
	case stageOstrichID:
		return m.updateOstrichIDKey(msg)
	}

	if m.menu != nil {
		return m.updateMenuKey(msg)
	}

	if m.safetyOpen {
		return m.updateSafetyKey(msg)
	}

	switch m.focus {
	case paneChat:
		if m.chat != nil {
			return m.updateChatKey(msg)
		}
	case paneSettings:
		if m.settings != nil {
			return m.updateSettingsKey(msg)
		}
	}

	return m.updateListKey(msg)
}

func (m *model) updateMouse(msg tea.MouseMsg) tea.Cmd {
	switch m.stage {
	case stageAuth:
		return m.updateAuthMouse(msg)
	case stageOstrichID:
		return m.updateOstrichIDMouse(msg)
	}

	if m.menu != nil {
		return m.updateMenuMouse(msg)
	}

	if m.safetyOpen {
		return m.updateSafetyMouse(msg)
	}

	if cmd, ok := m.updateListMouse(msg); ok {
		return cmd
	}

	if m.settings != nil && m.showingSettings() {
		return m.updateSettingsMouse(msg)
	}

	if m.chat != nil && m.showingChat() {
		return m.updateChatMouse(msg)
	}

	return nil
}

// clicked tells whether a left click (press) hit the zone.
func clicked(msg tea.MouseMsg, id string) bool {
	return msg.Action == tea.MouseActionPress &&
		msg.Button == tea.MouseButtonLeft &&
		zone.Get(id).InBounds(msg)
}

// rightClicked tells whether a right click hit the zone.
func rightClicked(msg tea.MouseMsg, id string) bool {
	return msg.Action == tea.MouseActionPress &&
		msg.Button == tea.MouseButtonRight &&
		zone.Get(id).InBounds(msg)
}

// wheel returns -1 / 1 for the wheel turned up / down over the zone.
func wheel(msg tea.MouseMsg, id string) int {
	if msg.Action != tea.MouseActionPress || !zone.Get(id).InBounds(msg) {
		return 0
	}

	switch msg.Button {
	case tea.MouseButtonWheelUp:
		return -1
	case tea.MouseButtonWheelDown:
		return 1
	}

	return 0
}

// --- layout ---

func (m model) wide() bool {
	return m.width >= wideLayoutMinWidth
}

func (m model) sidebarWidth() int {
	if !m.wide() {
		return m.width
	}

	return min(max(m.width*32/100, 32), 44)
}

// paneWidth is the width of the chat or Settings.
func (m model) paneWidth() int {
	if !m.wide() {
		return m.width
	}

	return m.width - m.sidebarWidth() - 1
}

func (m model) showingChat() bool {
	return m.chat != nil && (m.wide() && m.settings == nil || m.focus == paneChat)
}

func (m model) showingSettings() bool {
	return m.settings != nil && (m.wide() || m.focus == paneSettings)
}

func (m model) showingList() bool {
	return m.wide() || m.focus == paneList
}

// layoutInputs sizes the inputs to the terminal.
func (m *model) layoutInputs() {
	m.auth.resize(m.width)
	m.list.resize(m.sidebarWidth())

	if m.chat != nil {
		m.chat.resize(m.paneWidth())
	}

	if m.settings != nil {
		m.settings.resize(m.paneWidth())
	}
}

// --- session ---

// startSession begins the session after logging in or registering.
func (m *model) startSession(result *LoginResponse) tea.Cmd {
	m.user = result
	m.presence = map[string]presence{}
	m.typingUntil = map[string]time.Time{}
	m.knownKeys = loadKnownKeys(result.User.ID)
	m.keyChanged = map[string]bool{}
	m.chats = nil
	m.chatsLoaded = false
	m.chat = nil
	m.settings = nil
	m.menu = nil
	m.focus = paneList
	m.list = newListState(m.pal)
	m.list.resize(m.sidebarWidth())
	m.auth.reset()

	m.stage = stageMain

	if result.OstrichID != "" {
		m.stage = stageOstrichID
		m.idSaved = false
		m.quitArmed = false
	}

	m.closeConnection()
	m.connStatus = connConnecting

	return tea.Batch(m.loadChats(), connectCmd(result.Token, m.connGen, 0))
}

// signOut drops the session (and forgets a remembered one) and returns
// to the login screen.
func (m *model) signOut(notice string) tea.Cmd {
	m.closeConnection()
	clearChatKeys()

	remembered := m.remembered
	m.remembered = false
	m.rememberLater = false

	m.user = nil
	m.chats = nil
	m.chat = nil
	m.settings = nil
	m.menu = nil
	m.safetyOpen = false
	m.knownKeys = nil
	m.keyChanged = nil
	m.presence = map[string]presence{}
	m.stage = stageAuth
	m.auth.reset()
	m.auth.notice = notice
	m.toast = ""

	if !remembered {
		return nil
	}

	return func() tea.Msg {
		forgetSession()
		return nil
	}
}

// quit exits; a session that is not remembered is ended on the server.
func (m *model) quit() tea.Cmd {
	m.closeConnection()

	if m.user == nil || m.remembered || m.rememberLater {
		return tea.Quit
	}

	token := m.user.Token

	return tea.Sequence(
		func() tea.Msg {
			_ = logout(token)
			return nil
		},
		tea.Quit,
	)
}

// updateTitle puts the unread count into the window title.
func (m *model) updateTitle() tea.Cmd {
	title := "Ostrich"

	if unread := m.totalUnread(); unread > 0 {
		title = fmt.Sprintf("(%d) Ostrich", unread)
	}

	if title == m.title {
		return nil
	}

	m.title = title

	return tea.SetWindowTitle(title)
}

func (m model) totalUnread() int {
	total := 0

	for _, chat := range m.chats {
		total += chat.UnreadCount
	}

	return total
}

// bell rings the terminal bell for a new message, if turned on.
func (m model) bell() {
	if m.cfg.Bell {
		_, _ = os.Stdout.WriteString("\a")
	}
}

// --- view ---

func (m model) View() string {
	if m.width == 0 || m.height == 0 {
		return ""
	}

	var view string

	switch m.stage {
	case stageAuth:
		view = m.authView()
	case stageOstrichID:
		view = m.ostrichIDView()
	default:
		view = m.mainView()
	}

	return zone.Scan(view)
}

func (m model) mainView() string {
	var view string

	switch {
	case m.wide():
		var right string

		switch {
		case m.settings != nil:
			right = m.settingsView(m.paneWidth(), m.height)
		case m.chat != nil:
			right = m.chatView(m.paneWidth(), m.height)
		default:
			right = m.emptyPaneView(m.paneWidth(), m.height)
		}

		divider := fitBlock("", 1, m.height, m.pal.line)
		view = hjoin(m.listView(m.sidebarWidth(), m.height), divider, right)

	case m.focus == paneSettings && m.settings != nil:
		view = m.settingsView(m.width, m.height)

	case m.focus == paneChat && m.chat != nil:
		view = m.chatView(m.width, m.height)

	default:
		view = m.listView(m.width, m.height)
	}

	if m.menu != nil {
		view = overlay(view, m.menuView(), m.width, m.height)
	} else if m.safetyOpen && m.chat != nil {
		view = overlay(view, m.safetyView(), m.width, m.height)
	}

	return view
}

// emptyPaneView is the right side with no chat open.
func (m model) emptyPaneView(w, h int) string {
	p := m.pal
	lines := []string{
		center(bold("Select a chat", p.text, p.bg), w, p.bg),
		"",
		center(seg("or start one by @username: press n", p.muted, p.bg), w, p.bg),
	}

	top := max((h-len(lines))/2, 0)
	block := ""

	for i := 0; i < top; i++ {
		block += "\n"
	}

	for _, line := range lines {
		block += line + "\n"
	}

	return fitBlock(block, w, h, p.bg)
}

// hintLine is the bottom line: key hints, or the toast.
func (m model) hintLine(hints string, w int, bg lipgloss.Color) string {
	p := m.pal

	if m.toast != "" {
		fg := p.online

		if m.toastErr {
			fg = p.danger
		}

		return fitLine(seg(" "+clip(sanitize(m.toast), w-2), fg, bg), w, bg)
	}

	return fitLine(seg(" "+clip(hints, w-2), p.muted, bg), w, bg)
}
