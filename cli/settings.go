package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// Settings screen: change username, change password, log out of all
// devices.

const minPasswordLength = 8

const (
	settingsNewUsername = iota
	settingsUsernamePassword
	settingsCurrent
	settingsNew
	settingsConfirm
	settingsFields
)

type usernameChangedMsg struct {
	account *Account
}

type usernameChangeErrorMsg struct {
	err error
}

type passwordChangedMsg struct{}

type passwordChangeErrorMsg struct {
	err error
}

type loggedOutAllMsg struct{}

type logoutAllErrorMsg struct {
	err error
}

func newPasswordInput(placeholder string) textinput.Model {
	input := textinput.New()
	input.Placeholder = placeholder
	input.CharLimit = 128
	input.Width = 40
	input.EchoMode = textinput.EchoPassword
	input.EchoCharacter = '•'

	return input
}

func newSettingsInputs() [settingsFields]textinput.Model {
	username := textinput.New()
	username.Placeholder = "@username"
	username.CharLimit = 33
	username.Width = 40

	return [settingsFields]textinput.Model{
		username,
		newPasswordInput("Password"),
		newPasswordInput("Current password"),
		newPasswordInput("New password"),
		newPasswordInput("Confirm new password"),
	}
}

func changeUsernameCmd(token, username, password string) tea.Cmd {
	return func() tea.Msg {
		account, err := changeUsername(token, username, password)
		if err != nil {
			return usernameChangeErrorMsg{err: err}
		}

		return usernameChangedMsg{account: account}
	}
}

func changePasswordCmd(token, currentPassword, newPassword string) tea.Cmd {
	return func() tea.Msg {
		if err := changePassword(token, currentPassword, newPassword); err != nil {
			return passwordChangeErrorMsg{err: err}
		}

		return passwordChangedMsg{}
	}
}

func logoutAllCmd(token string) tea.Cmd {
	return func() tea.Msg {
		if err := logoutAll(token); err != nil {
			return logoutAllErrorMsg{err: err}
		}

		return loggedOutAllMsg{}
	}
}

func (m tuiModel) openSettings() (tea.Model, tea.Cmd) {
	m.stage = stageSettings
	m.err = nil
	m.notice = ""
	m.confirmLogoutAll = false
	m.settingsInputs = newSettingsInputs()
	m.settingsFocus = 0

	return m, m.settingsInputs[0].Focus()
}

func (m *tuiModel) focusSetting(index int) tea.Cmd {
	m.settingsFocus = (index%settingsFields + settingsFields) % settingsFields

	for i := range m.settingsInputs {
		m.settingsInputs[i].Blur()
	}

	return m.settingsInputs[m.settingsFocus].Focus()
}

// updateSettingsResult handles the results of settings requests.
func (m tuiModel) updateSettingsResult(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case usernameChangedMsg:
		m.loading = false
		m.err = nil
		m.user.User = *msg.account
		m.notice = "Username changed. Use the new one to log in."
		m.settingsInputs = newSettingsInputs()

		return m, m.focusSetting(m.settingsFocus)

	case usernameChangeErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		m.loading = false
		m.err = msg.err

		return m, nil

	case passwordChangedMsg:
		m.loading = false
		m.err = nil
		m.notice = "Password changed. Other devices have been logged out."
		m.settingsInputs = newSettingsInputs()

		return m, m.focusSetting(m.settingsFocus)

	case passwordChangeErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		m.loading = false
		m.err = msg.err

		return m, nil

	case loggedOutAllMsg:
		// The server has also closed this session's websocket.
		return m.signedOut(nil, "Logged out of all devices.")

	case logoutAllErrorMsg:
		if errors.Is(msg.err, errSessionExpired) {
			return m.sessionExpired()
		}

		m.loading = false
		m.confirmLogoutAll = false
		m.err = msg.err

		return m, nil
	}

	return m, nil
}

func (m tuiModel) updateSettings(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.loading {
		return m, nil
	}

	key := msg.String()

	// Any other key cancels a pending "log out of all devices".
	if key != "ctrl+o" {
		m.confirmLogoutAll = false
	}

	switch key {

	case "esc":
		for i := range m.settingsInputs {
			m.settingsInputs[i].Blur()
		}

		m.stage = stageChats
		m.err = nil
		m.notice = ""

		return m, loadChatsCmd(m.user.Token)

	case "up", "shift+tab":
		return m, m.focusSetting(m.settingsFocus - 1)

	case "down", "tab":
		return m, m.focusSetting(m.settingsFocus + 1)

	case "ctrl+o":
		if !m.confirmLogoutAll {
			m.confirmLogoutAll = true
			m.err = nil
			m.notice = ""

			return m, nil
		}

		m.loading = true
		m.err = nil

		return m, logoutAllCmd(m.user.Token)

	case "enter":
		if m.settingsFocus <= settingsUsernamePassword {
			return m.submitUsername()
		}

		current := m.settingsInputs[settingsCurrent].Value()
		newPassword := m.settingsInputs[settingsNew].Value()
		confirm := m.settingsInputs[settingsConfirm].Value()

		m.notice = ""

		switch {
		case current == "":
			m.err = fmt.Errorf("current password is required")

		case len(newPassword) < minPasswordLength:
			m.err = fmt.Errorf(
				"new password must be at least %d characters",
				minPasswordLength,
			)

		case newPassword != confirm:
			m.err = fmt.Errorf("new passwords do not match")

		default:
			m.loading = true
			m.err = nil

			return m, changePasswordCmd(m.user.Token, current, newPassword)
		}

		return m, nil
	}

	var cmd tea.Cmd

	m.settingsInputs[m.settingsFocus], cmd =
		m.settingsInputs[m.settingsFocus].Update(msg)

	return m, cmd
}

func (m tuiModel) submitUsername() (tea.Model, tea.Cmd) {
	username := strings.TrimPrefix(
		strings.TrimSpace(m.settingsInputs[settingsNewUsername].Value()),
		"@",
	)
	password := m.settingsInputs[settingsUsernamePassword].Value()

	m.notice = ""

	switch {
	case !validUsername(username):
		m.err = errInvalidUsername

	case password == "":
		m.err = fmt.Errorf("password is required")

	default:
		m.loading = true
		m.err = nil

		return m, changeUsernameCmd(m.user.Token, username, password)
	}

	return m, nil
}

// nextUsernameChange returns when the username can be changed again, or ""
// if it can be now.
func (m tuiModel) nextUsernameChange() string {
	next := parseTime(m.user.User.NextUsernameChangeAt)

	if next == nil || !next.After(time.Now()) {
		return ""
	}

	return next.Local().Format("02.01.2006")
}

func (m tuiModel) settingsView() string {
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString(logoStyle.Render("OSTRICH   /   Settings"))
	b.WriteString("\n\n")

	var form strings.Builder

	form.WriteString("Username\n")
	form.WriteString(hintStyle.Render(
		"You are @" + sanitize(m.user.User.Username) +
			". You log in with it; it can be changed once every 28 days.",
	))
	form.WriteString("\n")

	if next := m.nextUsernameChange(); next != "" {
		form.WriteString(hintStyle.Render("You can change it again on " + next + "."))
		form.WriteString("\n")
	}

	form.WriteString("\n")
	form.WriteString(labelStyle.Render("New username"))
	form.WriteString("\n")
	form.WriteString(inputStyle.Render(m.settingsInputs[settingsNewUsername].View()))
	form.WriteString("\n\n")
	form.WriteString(labelStyle.Render("Password"))
	form.WriteString("\n")
	form.WriteString(inputStyle.Render(m.settingsInputs[settingsUsernamePassword].View()))
	form.WriteString("\n\n\n")

	form.WriteString("Change password\n")
	form.WriteString(hintStyle.Render("Your other devices will be logged out."))
	form.WriteString("\n\n")

	labels := []string{
		"Current password",
		"New password",
		"Confirm new password",
	}

	for i, label := range labels {
		form.WriteString(labelStyle.Render(label))
		form.WriteString("\n")
		form.WriteString(inputStyle.Render(m.settingsInputs[settingsCurrent+i].View()))

		if i < len(labels)-1 {
			form.WriteString("\n\n")
		}
	}

	form.WriteString("\n\n\nDevices\n")

	if m.confirmLogoutAll {
		form.WriteString(selectedChatStyle.Render(
			"Press Ctrl+O again to log out of ALL devices, including this one.",
		))
	} else {
		form.WriteString(hintStyle.Render(
			"Ctrl+O logs out of all devices (if someone else may have access).",
		))
	}

	b.WriteString(chatBoxStyle.Render(form.String()))
	b.WriteString("\n\n")

	if m.loading {
		b.WriteString("Please wait...")
	} else {
		b.WriteString(hintStyle.Render(
			"↑↓ Field   Enter Save the focused section   Ctrl+O Log out everywhere   Esc Back",
		))
	}

	b.WriteString("\n")

	if m.notice != "" {
		b.WriteString(successStyle.Render("✓ " + m.notice))
		b.WriteString("\n")
	}

	if m.err != nil {
		b.WriteString(errorStyle.Render("Error: " + sanitize(m.err.Error())))
		b.WriteString("\n")
	}

	return b.String()
}
