package main

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// The safety code of the open chat (Ctrl+K): both members see the same
// digits unless the server swapped their keys.

func (m tuiModel) updateSafetyCode(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		if m.keyChanged[m.currentChat.UserID] {
			m.acceptPeerKey(m.currentChat)
			m.err = nil
		}

		m.safetyOpen = false

		return m, m.messageInput.Focus()

	case "esc", "enter", "ctrl+k":
		m.safetyOpen = false

		return m, m.messageInput.Focus()
	}

	return m, nil
}

func (m tuiModel) safetyCodeView() string {
	name := sanitize(m.currentChat.Username)

	if m.user == nil || m.currentChat.PublicKey == "" {
		return hintStyle.Render("@" + name + " has not set up end-to-end encryption yet.")
	}

	own, err := publicKeyOf(m.user.PrivateKey)
	if err != nil {
		return errorStyle.Render("Error: " + err.Error())
	}

	code, err := safetyCode(own, m.currentChat.PublicKey)
	if err != nil {
		return errorStyle.Render("Error: " + err.Error())
	}

	var b strings.Builder

	b.WriteString(labelStyle.Render("Safety code with @" + name))
	b.WriteString("\n\n")
	b.WriteString(selectedChatStyle.Render(strings.Join(code[:4], "  ")))
	b.WriteString("\n")
	b.WriteString(selectedChatStyle.Render(strings.Join(code[4:], "  ")))
	b.WriteString("\n\n")
	b.WriteString("Compare it with the code @" + name + " sees for this chat, in person\n" +
		"or over another app. If both are the same, your messages are readable\n" +
		"only by the two of you.")

	if m.keyChanged[m.currentChat.UserID] {
		b.WriteString("\n\n")
		b.WriteString(errorStyle.Render(
			"The security key of @" + name + " has changed. That happens when they set up\n" +
				"encryption again, but it can also mean someone is trying to read the chat.\n" +
				"Press y only after you have compared the codes.",
		))
	}

	return b.String()
}
