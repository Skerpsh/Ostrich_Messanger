package main

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Key handling of the login, chats and chat screens.

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

	// Tab / Shift+Tab switch between Login and Register.
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

	// The arrows move between the fields.
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
	if m.safetyOpen {
		return m.updateSafetyCode(msg)
	}

	if m.selecting {
		return m.updateSelecting(msg)
	}

	switch msg.String() {

	case "ctrl+k":
		m.safetyOpen = true
		m.messageInput.Blur()

		return m, nil

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

		if m.currentChat.Blocked {
			m.err = fmt.Errorf("you can't message this user")
			return m, nil
		}

		if m.keyChanged[m.currentChat.UserID] {
			m.err = fmt.Errorf("the other user's security key has changed: compare the safety code first (Ctrl+K)")
			return m, nil
		}

		// The server only takes end-to-end encrypted messages, bound to the
		// id chosen here.
		id := newMessageID()

		encrypted, err := encryptMessage(content, id, m.user.User.ID, m.user.PrivateKey, m.currentChat.PublicKey, m.currentChat.ID)
		if err != nil {
			m.err = err
			return m, nil
		}

		payload := map[string]string{
			"type":    "message",
			"chatId":  m.currentChat.ID,
			"id":      id,
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
