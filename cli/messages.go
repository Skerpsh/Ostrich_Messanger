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
}

type MessagesResponse struct {
	Messages []Message `json:"messages"`
}

func getMessages(token string, chatID string) ([]Message, error) {
	var result MessagesResponse

	path := "/api/chats/" + url.PathEscape(chatID) + "/messages"

	if err := authorizedGet(token, path, &result); err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}

	return result.Messages, nil
}
