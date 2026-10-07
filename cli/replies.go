package main

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Replies: with an empty input, ↑ starts selecting a message; ↑/↓ move the
// selection, Enter or r replies to it, Esc cancels.

const quoteLength = 60

// ReplyPreview is the start of the message a reply refers to.
type ReplyPreview struct {
	ID             string `json:"id"`
	SenderID       string `json:"sender_id"`
	SenderUsername string `json:"sender_username"`
	Content        string `json:"content"`
}

// shorten makes one line of at most n runes.
func shorten(text string, n int) string {
	text = strings.Join(strings.Fields(sanitize(text)), " ")

	if runes := []rune(text); len(runes) > n {
		return string(runes[:n-1]) + "…"
	}

	return text
}

// senderName is how a message's sender is shown in quotes.
func (m tuiModel) senderName(senderID, username string) string {
	if m.user != nil && senderID == m.user.User.ID {
		return "You"
	}

	return sanitize(username)
}

// quoteLine renders the quoted message above a reply.
func (m tuiModel) quoteLine(reply *ReplyPreview) string {
	return hintStyle.Render(
		"↪ " + m.senderName(reply.SenderID, reply.SenderUsername) + ": " +
			shorten(reply.Content, quoteLength),
	)
}

// resetReply leaves the selection mode and drops a pending reply.
func (m *tuiModel) resetReply() {
	m.selecting = false
	m.selectedMessage = 0
	m.replyTo = nil
}

// keepSelectionVisible scrolls so the selected message is the newest one
// shown.
func (m *tuiModel) keepSelectionVisible() {
	m.messageScroll = len(m.messages) - 1 - m.selectedMessage
}

// updateSelecting handles keys while a message is being selected.
func (m tuiModel) updateSelecting(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {

	case "up", "k":
		if m.selectedMessage > 0 {
			m.selectedMessage--
			m.keepSelectionVisible()
		}

	case "down", "j":
		if m.selectedMessage < len(m.messages)-1 {
			m.selectedMessage++
			m.keepSelectionVisible()
		}

	case "enter", "r":
		message := m.messages[m.selectedMessage]
		m.replyTo = &message
		m.selecting = false
		m.messageScroll = 0

		return m, m.messageInput.Focus()

	case "esc":
		m.selecting = false
		m.messageScroll = 0

		return m, m.messageInput.Focus()
	}

	return m, nil
}

// replyBar is shown above the input while replying.
func (m tuiModel) replyBar() string {
	if m.replyTo == nil {
		return ""
	}

	return selectedChatStyle.Render("↪ Replying to "+
		m.senderName(m.replyTo.SenderID, m.replyTo.SenderUsername)) +
		hintStyle.Render(": "+shorten(m.replyTo.Content, quoteLength)+"   (Esc cancels)")
}
