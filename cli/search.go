package main

import (
	"sort"
	"strings"
)

// Searching all chats, like the app (frontend/src/lib/search.ts): the
// server cannot (the messages are encrypted), so what this computer has
// is decrypted and searched: the open chat and, in a remembered session,
// the saved history of each chat (cache.go).

type messageMatch struct {
	chat    Chat
	message Message
	// The text without formatting.
	text string
}

const maxMessageMatches = 30

func (m model) searchMessages(query string) []messageMatch {
	needle := strings.ToLower(strings.TrimSpace(query))

	if len([]rune(needle)) < 2 || m.user == nil {
		return nil
	}

	byChat := map[string][]Message{}

	if m.cache != nil {
		for chatID, messages := range m.cache.Messages {
			byChat[chatID] = messages
		}
	}

	if m.chat != nil {
		byChat[m.chat.id] = m.chat.messages
	}

	var found []messageMatch

	for _, chat := range m.chats {
		for _, message := range byChat[chat.ID] {
			if message.Kind == "system" {
				continue
			}

			shown := m.show(chat, message.ID, message.SenderID, message.Content)

			if shown.status != decryptOK {
				continue
			}

			text := strings.TrimSpace(plainText(shown.text))

			if text == "" {
				text = attachmentsLabel(shown.attachments)
			}

			if strings.Contains(strings.ToLower(text), needle) {
				found = append(found, messageMatch{chat: chat, message: message, text: text})
			}
		}
	}

	sort.SliceStable(found, func(i, j int) bool {
		return found[i].message.CreatedAt > found[j].message.CreatedAt
	})

	if len(found) > maxMessageMatches {
		found = found[:maxMessageMatches]
	}

	return found
}
