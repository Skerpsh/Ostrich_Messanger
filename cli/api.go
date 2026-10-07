package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const defaultServerURL = "https://62.238.111.55.nip.io"

// serverURL can be overridden with OSTRICH_SERVER, e.g.
// OSTRICH_SERVER=http://localhost:3000 for a local backend.
var serverURL = strings.TrimRight(
	envOr("OSTRICH_SERVER", defaultServerURL),
	"/",
)

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}

	return fallback
}

const requestTimeout = 15 * time.Second

// Message history (up to 500 messages of 4096 characters, encrypted) fits
// easily.
const maxResponseSize = 16 << 20

var httpClient = &http.Client{Timeout: requestTimeout}

// errSessionExpired is returned when the server rejects the auth token.
var errSessionExpired = errors.New("session expired, please log in again")

// Account is the logged-in user as the server returns it to its owner.
type Account struct {
	ID       string `json:"id"`
	Username string `json:"username"`

	// When the username can be changed again; nil if it can be now.
	NextUsernameChangeAt *string `json:"next_username_change_at"`

	// Shows the DEV badge.
	IsDeveloper bool `json:"is_developer"`
}

type LoginResponse struct {
	Message string  `json:"message"`
	Token   string  `json:"token"`
	User    Account `json:"user"`

	// Login only: the account's keys, the private key encrypted.
	Keys *AccountKeys `json:"keys"`

	// Set on this device. OstrichID: only right after registration (shown
	// once). PrivateKey: decrypts the account's chats.
	OstrichID  string `json:"-"`
	PrivateKey []byte `json:"-"`
}

// apiError is an error answer of the server.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

var errInvalidOstrichID = errors.New(
	"an OstrichID has 20 letters and digits, like XXXX-XXXX-XXXX-XXXX-XXXX",
)

var errWrongCredentials = errors.New("Invalid username, password or OstrichID")

type Chat struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Created     string `json:"created_at"`
	Updated     string `json:"updated_at"`
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	IsDeveloper bool   `json:"is_developer"`

	// The other member's public key; "" until they set up encryption.
	PublicKey string `json:"public_key"`

	// This user's settings for the chat.
	Pinned      bool `json:"pinned"`
	Muted       bool `json:"muted"`
	BlockedByMe bool `json:"blocked_by_me"`
	// Either has blocked the other: no messages in either direction.
	Blocked bool `json:"blocked"`

	// Presence of the other user.
	Online     bool    `json:"online"`
	LastSeenAt *string `json:"last_seen_at"`

	LastMessage *LastMessage `json:"last_message"`
	// Messages from the other user not read yet.
	UnreadCount int `json:"unread_count"`
}

// LastMessage is the start of a chat's newest message, for previews.
type LastMessage struct {
	ID        string `json:"id"`
	SenderID  string `json:"sender_id"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type ChatsResponse struct {
	Chats []Chat `json:"chats"`
}

// loginWithCredentials logs in with username, password and OstrichID. The
// OstrichID itself is not sent: only the auth key derived from it (see
// crypto.go). Accounts from before end-to-end encryption are set up on the
// way.
func loginWithCredentials(username, password, ostrichIDInput string) (*LoginResponse, error) {
	id := normalizeOstrichID(ostrichIDInput)

	if id == "" {
		return nil, errInvalidOstrichID
	}

	derived := deriveFromOstrichID(id)
	body := map[string]any{
		"username": username,
		"password": password,
		"auth_key": derived.authKey,
	}

	result, err := authRequest("/api/auth/login", body)

	var apiErr *apiError

	if errors.As(err, &apiErr) && apiErr.code == "upgrade_required" {
		material, _ := createAccountKeys(derived)
		body["ostrich_id"] = id
		body["keys"] = material
		result, err = authRequest("/api/auth/login", body)
	}

	if err != nil {
		return nil, err
	}

	if result.Keys == nil {
		return nil, fmt.Errorf("server did not return the account keys")
	}

	privateKey, err := openPrivateKey(derived, result.Keys.EncryptedPrivateKey)
	if err != nil {
		return nil, errWrongCredentials
	}

	result.PrivateKey = privateKey

	return result, nil
}

// registerWithCredentials creates the account. Its OstrichID is generated
// here and never sent; the response carries it (formatted) to show once.
func registerWithCredentials(username, password string) (*LoginResponse, error) {
	id := generateOstrichID()
	material, privateKey := createAccountKeys(deriveFromOstrichID(id))

	result, err := authRequest("/api/auth/register", map[string]any{
		"username": username,
		"password": password,
		"keys":     material,
	})
	if err != nil {
		return nil, err
	}

	result.OstrichID = formatOstrichID(id)
	result.PrivateKey = privateKey

	return result, nil
}

func logout(token string) error {
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/auth/logout", nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+token)

	return doJSON(req, nil)
}

// logoutAll ends every session of the user, including this one.
func logoutAll(token string) error {
	return authorizedPost(token, "/api/auth/logout-all", struct{}{}, nil)
}

// changeUsername sets a new username (allowed right after registration,
// then once per 28 days) and returns the updated account.
func changeUsername(token, username, password string) (*Account, error) {
	var result struct {
		User Account `json:"user"`
	}

	err := authorizedPost(token, "/api/auth/username", map[string]string{
		"username": username,
		"password": password,
	}, &result)
	if err != nil {
		return nil, err
	}

	return &result.User, nil
}

// changePassword changes the password and ends all other sessions.
func changePassword(token, currentPassword, newPassword string) error {
	return authorizedPost(token, "/api/auth/password", map[string]string{
		"current_password": currentPassword,
		"new_password":     newPassword,
	}, nil)
}

// authRequest posts credentials to an auth endpoint.
func authRequest(endpoint string, credentials map[string]any) (*LoginResponse, error) {
	body, err := json.Marshal(credentials)
	if err != nil {
		return nil, fmt.Errorf("failed to encode request: %w", err)
	}

	req, err := http.NewRequest(
		http.MethodPost,
		serverURL+endpoint,
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	var result LoginResponse

	if err := doJSON(req, &result); err != nil {
		return nil, err
	}

	if result.Token == "" {
		return nil, fmt.Errorf("server did not return authentication token")
	}

	return &result, nil
}

// authorizedPost sends v as JSON in an authenticated POST request and
// decodes the response into out.
func authorizedPost(token, path string, v any, out any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, serverURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	return doJSON(req, out)
}

// authorizedGet performs an authenticated GET request and decodes the
// response into out.
func authorizedGet(token, path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, serverURL+path, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)

	return doJSON(req, out)
}

// doJSON sends the request, turns non-2xx responses into errors using the
// server's error message when available, and decodes the body into out.
func doJSON(req *http.Request, out any) error {
	// Shown in the list of devices in the apps' Settings.
	req.Header.Set("X-Ostrich-Client", "cli")

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("server connection failed: %w", err)
	}

	defer resp.Body.Close()

	// Bound the response size so a misbehaving server cannot exhaust memory.
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize+1))
	if err != nil {
		return fmt.Errorf("failed to read server response: %w", err)
	}

	if len(responseBody) > maxResponseSize {
		return fmt.Errorf("server response is too large")
	}

	if resp.StatusCode == http.StatusUnauthorized &&
		req.Header.Get("Authorization") != "" {
		return errSessionExpired
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var serverError struct {
			Message string `json:"message"`
			Error   string `json:"error"`
			Code    string `json:"code"`
		}

		if json.Unmarshal(responseBody, &serverError) == nil {
			message := serverError.Error

			if serverError.Message != "" {
				message = serverError.Message
			}

			if message != "" {
				return &apiError{status: resp.StatusCode, code: serverError.Code, message: message}
			}
		}

		return fmt.Errorf(
			"request failed: HTTP %d: %s",
			resp.StatusCode,
			strings.TrimSpace(string(responseBody)),
		)
	}

	if out == nil {
		return nil
	}

	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("invalid server response: %w", err)
	}

	return nil
}

func getChats(token string) ([]Chat, error) {
	var result ChatsResponse

	if err := authorizedGet(token, "/api/chats", &result); err != nil {
		return nil, fmt.Errorf("failed to get chats: %w", err)
	}

	return result.Chats, nil
}

type createChatResponse struct {
	Chat struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Created string `json:"created_at"`
	} `json:"chat"`

	User struct {
		ID          string  `json:"id"`
		Username    string  `json:"username"`
		IsDeveloper bool    `json:"is_developer"`
		PublicKey   string  `json:"public_key"`
		Online      bool    `json:"online"`
		LastSeenAt  *string `json:"last_seen_at"`
	} `json:"user"`
}

// createChat opens (or returns the existing) direct chat with the user
// that has exactly this username.
func createChat(token, username string) (Chat, error) {
	var result createChatResponse

	err := authorizedPost(token, "/api/chats", map[string]string{
		"username": username,
	}, &result)
	if err != nil {
		return Chat{}, fmt.Errorf("failed to create chat: %w", err)
	}

	return Chat{
		ID:          result.Chat.ID,
		Type:        result.Chat.Type,
		Created:     result.Chat.Created,
		UserID:      result.User.ID,
		Username:    result.User.Username,
		IsDeveloper: result.User.IsDeveloper,
		PublicKey:   result.User.PublicKey,

		Online:     result.User.Online,
		LastSeenAt: result.User.LastSeenAt,
	}, nil
}

// websocketURL derives the websocket endpoint from serverURL
// (https -> wss, http -> ws).
func websocketURL() (string, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", fmt.Errorf("invalid server URL: %w", err)
	}

	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("invalid server URL scheme: %q", u.Scheme)
	}

	u.Path = strings.TrimRight(u.Path, "/") + "/ws"

	return u.String(), nil
}
