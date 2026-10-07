package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
)

// The API calls behind the chat, list and settings actions; the same as
// the web app's (frontend/src/lib/api.ts).

func chatPath(chatID string) string {
	return "/api/chats/" + url.PathEscape(chatID)
}

func messagePath(chatID, messageID string) string {
	return chatPath(chatID) + "/messages/" + url.PathEscape(messageID)
}

func getMe(token string) (*Account, error) {
	var result struct {
		User Account `json:"user"`
	}

	if err := authorizedGet(token, "/api/auth/me", &result); err != nil {
		return nil, err
	}

	return &result.User, nil
}

// sendMessage sends an encrypted message; id was chosen here (the
// encryption is bound to it).
func sendMessage(token, chatID, id, content, replyTo string) (Message, error) {
	body := map[string]string{"id": id, "content": content}

	if replyTo != "" {
		body["reply_to"] = replyTo
	}

	var result struct {
		Message Message `json:"message"`
	}

	err := authorizedPost(token, chatPath(chatID)+"/messages", body, &result)

	return result.Message, err
}

func editMessage(token, chatID, messageID, content string) (Message, error) {
	var result struct {
		Message Message `json:"message"`
	}

	err := authorizedJSON(token, http.MethodPatch, messagePath(chatID, messageID),
		map[string]string{"content": content}, &result)

	return result.Message, err
}

// deleteMessage deletes an own message for everyone.
func deleteMessage(token, chatID, messageID string) error {
	return authorizedJSON(token, http.MethodDelete, messagePath(chatID, messageID), nil, nil)
}

// setReaction sets the user's reaction; "" removes it.
func setReaction(token, chatID, messageID, emoji string) ([]Reaction, error) {
	var value any = emoji

	if emoji == "" {
		value = nil
	}

	var result struct {
		Reactions []Reaction `json:"reactions"`
	}

	err := authorizedJSON(token, http.MethodPut, messagePath(chatID, messageID)+"/reaction",
		map[string]any{"emoji": value}, &result)

	return result.Reactions, err
}

// setChatSettings pins / mutes a chat for this user; nil leaves a setting.
func setChatSettings(token, chatID string, pinned, muted *bool) error {
	body := map[string]bool{}

	if pinned != nil {
		body["pinned"] = *pinned
	}

	if muted != nil {
		body["muted"] = *muted
	}

	return authorizedJSON(token, http.MethodPut, chatPath(chatID)+"/settings", body, nil)
}

// deleteChat deletes the chat for both ("everyone") or clears its history
// for this user ("me").
func deleteChat(token, chatID, scope string) error {
	return authorizedJSON(token, http.MethodDelete, chatPath(chatID)+"?for="+scope, nil, nil)
}

// setPinnedMessage pins a message at the top of the chat for both
// members; "" unpins.
func setPinnedMessage(token, chatID, messageID string) error {
	var value any = messageID

	if messageID == "" {
		value = nil
	}

	return authorizedJSON(token, http.MethodPut, chatPath(chatID)+"/pinned-message",
		map[string]any{"message_id": value}, nil)
}

func setBlocked(token, userID string, blocked bool) error {
	method := http.MethodDelete

	if blocked {
		method = http.MethodPut
	}

	return authorizedJSON(token, method, "/api/users/"+url.PathEscape(userID)+"/block", nil, nil)
}

// setPrivacy changes the given privacy settings and returns the account.
func setPrivacy(token string, showPresence, readReceipts *bool) (*Account, error) {
	body := map[string]bool{}

	if showPresence != nil {
		body["show_presence"] = *showPresence
	}

	if readReceipts != nil {
		body["read_receipts"] = *readReceipts
	}

	var result struct {
		User Account `json:"user"`
	}

	if err := authorizedJSON(token, http.MethodPut, "/api/auth/privacy", body, &result); err != nil {
		return nil, err
	}

	return &result.User, nil
}

// Session is a device the user is logged in on.
type Session struct {
	ID         string  `json:"id"`
	Client     *string `json:"client"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt string  `json:"last_used_at"`
	Current    bool    `json:"current"`
}

func getSessions(token string) ([]Session, error) {
	var result struct {
		Sessions []Session `json:"sessions"`
	}

	if err := authorizedGet(token, "/api/auth/sessions", &result); err != nil {
		return nil, err
	}

	return result.Sessions, nil
}

// endSession logs one device out.
func endSession(token, sessionID string) error {
	return authorizedJSON(token, http.MethodDelete, "/api/auth/sessions/"+url.PathEscape(sessionID), nil, nil)
}

// deleteAccount needs the password and the OstrichID; the ID itself is not
// sent, only the auth key derived from it.
func deleteAccount(token, password, ostrichIDInput string) error {
	id := normalizeOstrichID(ostrichIDInput)

	if id == "" {
		return errInvalidOstrichID
	}

	return authorizedPost(token, "/api/auth/delete-account", map[string]string{
		"password": password,
		"auth_key": deriveFromOstrichID(id).authKey,
	}, nil)
}

// uploadAvatar sets the profile picture (JPEG, PNG or WebP); the server
// re-encodes it.
func uploadAvatar(token string, image []byte) (*Account, error) {
	contentType := http.DetectContentType(image)

	switch contentType {
	case "image/jpeg", "image/png", "image/webp":
	default:
		return nil, fmt.Errorf("choose a JPEG, PNG or WebP image")
	}

	req, err := http.NewRequest(http.MethodPut, serverURL+"/api/users/me/avatar", bytes.NewReader(image))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)

	var result struct {
		User Account `json:"user"`
	}

	if err := doJSON(req, &result); err != nil {
		return nil, err
	}

	return &result.User, nil
}

func removeAvatar(token string) (*Account, error) {
	var result struct {
		User Account `json:"user"`
	}

	if err := authorizedJSON(token, http.MethodDelete, "/api/users/me/avatar", nil, &result); err != nil {
		return nil, err
	}

	return &result.User, nil
}
