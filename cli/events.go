package main

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Events from other devices and the other member: edits, deletions,
// reactions, "typing…", deleted chats.

const typingDuration = 6 * time.Second

// Reaction is one user's reaction to a message.
type Reaction struct {
	Emoji  string `json:"emoji"`
	UserID string `json:"user_id"`
}

type typingExpiredMsg struct{}

func typingTick() tea.Cmd {
	return tea.Tick(typingDuration+100*time.Millisecond, func(time.Time) tea.Msg {
		return typingExpiredMsg{}
	})
}

// isTyping tells whether the other member of the chat is typing.
func (m tuiModel) isTyping(chatID string) bool {
	until, ok := m.typingUntil[chatID]

	return ok && time.Now().Before(until)
}

func (m *tuiModel) replaceMessage(updated Message) {
	for i := range m.messages {
		if m.messages[i].ID == updated.ID {
			m.messages[i] = updated
		}
	}

	if i := m.findChat(updated.ChatID); i >= 0 {
		if last := m.chats[i].LastMessage; last != nil && last.ID == updated.ID {
			last.Content = updated.Content
		}
	}
}

// handleChatEvent handles the events above; returns a command to run.
func (m *tuiModel) handleChatEvent(event WSMessage) tea.Cmd {
	viewing := m.stage == stageChat && event.ChatID == m.currentChat.ID

	switch event.Type {
	case "typing":
		if m.typingUntil == nil {
			m.typingUntil = map[string]time.Time{}
		}

		m.typingUntil[event.ChatID] = time.Now().Add(typingDuration)

		return typingTick()

	case "message_updated":
		if event.Message != nil {
			m.replaceMessage(*event.Message)
		}

	case "message_deleted":
		kept := m.messages[:0]

		for _, message := range m.messages {
			if message.ID != event.MessageID {
				kept = append(kept, message)
			}
		}

		m.messages = kept

		// The preview may need the message before it.
		if i := m.findChat(event.ChatID); i >= 0 {
			if last := m.chats[i].LastMessage; last != nil && last.ID == event.MessageID {
				return loadChatsCmd(m.user.Token)
			}
		}

	case "reactions":
		for i := range m.messages {
			if m.messages[i].ID == event.MessageID {
				m.messages[i].Reactions = event.Reactions
			}
		}

	case "chat_deleted":
		if viewing {
			m.resetReply()
			m.messageInput.Blur()
			m.stage = stageChats
			m.messages = nil
			m.err = fmt.Errorf("this chat was deleted")
		}

		return loadChatsCmd(m.user.Token)

	case "chats_changed":
		return loadChatsCmd(m.user.Token)
	}

	return nil
}

// reactionsLine shows a message's reactions: "👍 2  🔥".
func reactionsLine(reactions []Reaction) string {
	if len(reactions) == 0 {
		return ""
	}

	var order []string
	counts := map[string]int{}

	for _, r := range reactions {
		if counts[r.Emoji] == 0 {
			order = append(order, r.Emoji)
		}

		counts[r.Emoji]++
	}

	parts := make([]string, len(order))

	for i, emoji := range order {
		parts[i] = emoji

		if counts[emoji] > 1 {
			parts[i] += fmt.Sprintf(" %d", counts[emoji])
		}
	}

	return strings.Join(parts, "  ")
}
