package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// Settings screen: change password, log out of all devices.

const minPasswordLength = 8

const (
	settingsCurrent = iota
	settingsNew
	settingsConfirm
	settingsFields
)

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
	return [settingsFields]textinput.Model{
		newPasswordInput("Current password"),
		newPasswordInput("New password"),
		newPasswordInput("Confirm new password"),
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

	case passwordChangedMsg:
		m.loading = false
		m.err = nil
		m.notice = "Password changed. Other devices have been logged out."
		m.settingsInputs = newSettingsInputs()

		return m, m.focusSetting(0)

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

func (m tuiModel) settingsView() string {
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString(logoStyle.Render("OSTRICH   /   Settings"))
	b.WriteString("\n\n")

	var form strings.Builder

	form.WriteString("Change password\n")
	form.WriteString(hintStyle.Render("Your other devices will be logged out."))
	form.WriteString("\n\n")

	labels := [settingsFields]string{
		"Current password",
		"New password",
		"Confirm new password",
	}

	for i, label := range labels {
		form.WriteString(labelStyle.Render(label))
		form.WriteString("\n")
		form.WriteString(inputStyle.Render(m.settingsInputs[i].View()))

		if i < settingsFields-1 {
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
			"↑↓ Field   Enter Change password   Ctrl+O Log out everywhere   Esc Back",
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
