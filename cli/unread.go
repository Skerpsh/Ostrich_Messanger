package main

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Unread counts and last-message previews of the chats list, kept up to
// date from websocket events.

const previewLength = 36

var unreadStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(lipgloss.Color("0")).
	Background(lipgloss.Color("208"))

func (m *tuiModel) findChat(chatID string) int {
	for i, chat := range m.chats {
		if chat.ID == chatID {
			return i
		}
	}

	return -1
}

// markChatRead marks the open chat read up to the newest of messages and
// clears its unread count.
func (m *tuiModel) markChatRead(chatID string, messages []Message) tea.Cmd {
	if i := m.findChat(chatID); i >= 0 {
		m.chats[i].UnreadCount = 0
	}

	if len(messages) == 0 || m.user == nil {
		return nil
	}

	newest := messages[len(messages)-1]

	// Sending a message already marks the chat read on the server.
	if newest.SenderID == m.user.User.ID {
		return nil
	}

	token := m.user.Token

	return func() tea.Msg {
		_ = markRead(token, chatID, newest.ID)
		return nil
	}
}

// chatMessageArrived updates the chat's preview and unread count and moves
// it to the top. Returns false if the chat is not in the list.
func (m *tuiModel) chatMessageArrived(message Message, viewing bool) bool {
	i := m.findChat(message.ChatID)

	if i < 0 {
		return false
	}

	chat := m.chats[i]

	if chat.LastMessage != nil && chat.LastMessage.ID == message.ID {
		return true
	}

	chat.LastMessage = &LastMessage{
		ID:        message.ID,
		SenderID:  message.SenderID,
		Content:   message.Content,
		CreatedAt: message.CreatedAt,
	}

	switch {
	case message.SenderID == m.user.User.ID:
		chat.UnreadCount = 0

	case !viewing:
		chat.UnreadCount++
	}

	// Most recently active first; the cursor stays on the same chat.
	selectedID := ""

	if m.selected < len(m.chats) {
		selectedID = m.chats[m.selected].ID
	}

	rest := append([]Chat{}, m.chats[:i]...)
	rest = append(rest, m.chats[i+1:]...)
	m.chats = append([]Chat{chat}, rest...)

	for j, c := range m.chats {
		if c.ID == selectedID {
			m.selected = j
		}
	}

	return true
}

// chatReadElsewhere clears the unread count of a chat read on another
// device, if it was read up to its newest message.
func (m *tuiModel) chatReadElsewhere(chatID string, lastReadAt *string) {
	i := m.findChat(chatID)
	readAt := parseTime(lastReadAt)

	if i < 0 || readAt == nil {
		return
	}

	last := m.chats[i].LastMessage

	if last == nil {
		m.chats[i].UnreadCount = 0
		return
	}

	if created := parseTime(&last.CreatedAt); created != nil && !created.After(*readAt) {
		m.chats[i].UnreadCount = 0
	}
}

// chatPreview is the second line of a chat in the list: the start of its
// last message, or its @username when there are no messages.
func (m tuiModel) chatPreview(chat Chat) string {
	if m.isTyping(chat.ID) {
		return selectedChatStyle.Render("typing…")
	}

	last := chat.LastMessage

	if last == nil {
		return hintStyle.Render("@" + sanitize(chat.Username) + " · no messages yet")
	}

	text := strings.Join(strings.Fields(sanitize(m.textOf(chat, last.Content))), " ")

	if runes := []rune(text); len(runes) > previewLength {
		text = string(runes[:previewLength-1]) + "…"
	}

	if m.user != nil && last.SenderID == m.user.User.ID {
		text = "You: " + text
	}

	return hintStyle.Render(text)
}
