package main

import (
	"fmt"
	"net/url"
)

type Message struct {
	ID             string `json:"id"`
	ChatID         string `json:"chat_id"`
	SenderID       string `json:"sender_id"`
	SenderUsername string `json:"sender_username"`
	Content        string `json:"content"`
	CreatedAt      string `json:"created_at"`

	// The message this one replies to, if any.
	ReplyTo *ReplyPreview `json:"reply_to"`

	EditedAt  *string    `json:"edited_at"`
	Reactions []Reaction `json:"reactions"`
}

type MessagesResponse struct {
	Messages []Message `json:"messages"`

	// There are older messages than these.
	HasMore bool `json:"has_more"`
}

// markRead marks the chat read up to and including the message.
func markRead(token, chatID, messageID string) error {
	path := "/api/chats/" + url.PathEscape(chatID) + "/read"

	return authorizedPost(token, path, map[string]string{
		"message_id": messageID,
	}, nil)
}

// getMessages returns the newest messages of a chat.
func getMessages(token string, chatID string) (MessagesResponse, error) {
	var result MessagesResponse

	path := "/api/chats/" + url.PathEscape(chatID) + "/messages"

	if err := authorizedGet(token, path, &result); err != nil {
		return result, fmt.Errorf("failed to get messages: %w", err)
	}

	return result, nil
}

// reconcileMessages merges a freshly loaded page of the newest history:
// messages within the time span of the page that are not in it were
// deleted meanwhile (e.g. while offline) and are dropped; edits are taken
// over. complete: the page reaches back to the start of the chat.
func (m *tuiModel) reconcileMessages(page []Message, complete bool) {
	if len(page) == 0 {
		if complete {
			m.messages = nil
			m.messageScroll = 0
			m.resetReply()
		}

		return
	}

	inPage := make(map[string]Message, len(page))

	for _, message := range page {
		inPage[message.ID] = message
	}

	from, to := page[0].CreatedAt, page[len(page)-1].CreatedAt
	kept := make([]Message, 0, len(m.messages))

	for _, message := range m.messages {
		if fresh, ok := inPage[message.ID]; ok {
			kept = append(kept, fresh)
		} else if (!complete && message.CreatedAt < from) || message.CreatedAt > to {
			kept = append(kept, message)
		}
	}

	m.messages = kept
	m.mergeMessages(page)
	m.messageScroll = min(m.messageScroll, max(len(m.messages)-1, 0))

	if m.selecting && m.selectedMessage >= len(m.messages) {
		m.resetReply()
	}
}
