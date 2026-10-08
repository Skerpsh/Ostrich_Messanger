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
	// "system": written by the server about a group (content plain JSON).
	Kind      string `json:"kind"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`

	// The message this one replies to, if any.
	ReplyTo *ReplyPreview `json:"reply_to"`

	EditedAt  *string    `json:"edited_at"`
	Reactions []Reaction `json:"reactions"`
}

// ReplyPreview is the message a reply refers to.
type ReplyPreview struct {
	ID                string `json:"id"`
	SenderID          string `json:"sender_id"`
	SenderUsername    string `json:"sender_username"`
	SenderIsDeveloper bool   `json:"sender_is_developer"`
	Content           string `json:"content"`
}

// Reaction is one user's reaction to a message.
type Reaction struct {
	Emoji  string `json:"emoji"`
	UserID string `json:"user_id"`
}

// The emoji messages can be reacted with (the same as the server's).
var reactionEmoji = []string{"👍", "❤️", "😂", "😮", "😢", "🔥", "🙏", "👎"}

type MessagesResponse struct {
	Messages []Message `json:"messages"`

	// There are older messages than these.
	HasMore bool `json:"has_more"`

	// Up to when the signed-in user had read the chat, and the other
	// member (nil if either has read receipts off).
	LastReadAt     *string `json:"last_read_at"`
	PeerLastReadAt *string `json:"peer_last_read_at"`
}

// markRead marks the chat read up to and including the message.
func markRead(token, chatID, messageID string) error {
	path := "/api/chats/" + url.PathEscape(chatID) + "/read"

	return authorizedPost(token, path, map[string]string{
		"message_id": messageID,
	}, nil)
}

// getMessages returns the newest messages of a chat, or those before the
// message `before` ("" for the newest).
func getMessages(token, chatID, before string) (MessagesResponse, error) {
	var result MessagesResponse

	path := "/api/chats/" + url.PathEscape(chatID) + "/messages"

	if before != "" {
		path += "?before=" + url.QueryEscape(before)
	}

	if err := authorizedGet(token, path, &result); err != nil {
		return result, fmt.Errorf("failed to get messages: %w", err)
	}

	return result, nil
}
