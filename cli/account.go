package main

import (
	"errors"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Same rules as the backend.
var usernameRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

var errInvalidUsername = errors.New(
	"username: 3-32 characters, letters, digits, _ . - only",
)

func validUsername(username string) bool {
	return usernameRE.MatchString(username)
}

// OstrichID screen: shown once after registration. The ID is generated on
// this device and never sent to the server, so this is the only chance to
// save it.

func (m tuiModel) updateOstrichID(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// A distinct key rather than Enter, so a key still held from the login
	// form does not skip the screen.
	if msg.String() != "y" && msg.String() != "Y" {
		m.quitArmed = false
		return m, nil
	}

	m.user.OstrichID = ""
	m.quitArmed = false
	m.stage = stageChats
	m.loading = false

	return m, loadChatsCmd(m.user.Token)
}

func (m tuiModel) ostrichIDView() string {
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString(logoStyle.Render("OSTRICH   @" + sanitize(m.user.User.Username)))
	b.WriteString("\n\n")

	var box strings.Builder

	box.WriteString(labelStyle.Render("Your OstrichID"))
	box.WriteString("\n\n")
	box.WriteString(selectedChatStyle.Render("  " + sanitize(m.user.OstrichID)))
	box.WriteString("\n\n")
	box.WriteString("You need it to log in, together with your username and password.\n\n")
	box.WriteString(errorStyle.Render(
		"It is shown only this once. Ostrich cannot show it again or\n" +
			"recover it: if you lose it, you lose access to your account.",
	))
	box.WriteString("\n\n")
	box.WriteString("Save it somewhere safe, such as a password manager.")

	b.WriteString(chatBoxStyle.Render(box.String()))
	b.WriteString("\n\n")

	if m.quitArmed {
		b.WriteString(errorStyle.Render(
			"Press Ctrl+C again to quit. You will not see this OstrichID again.",
		))
	} else {
		b.WriteString(hintStyle.Render("Press y once you have saved your OstrichID"))
	}

	b.WriteString("\n")

	return b.String()
}
