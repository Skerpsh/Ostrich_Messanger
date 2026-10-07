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

var httpClient = &http.Client{Timeout: requestTimeout}

// errSessionExpired is returned when the server rejects the auth token.
var errSessionExpired = errors.New("session expired, please log in again")

type LoginResponse struct {
	Message string `json:"message"`
	Token   string `json:"token"`

	User struct {
		ID       string `json:"id"`
		LoginID  string `json:"login_id"`
		Username string `json:"username"`
	} `json:"user"`
}

type Chat struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Created  string `json:"created_at"`
	Updated  string `json:"updated_at"`
	UserID   string `json:"user_id"`
	LoginID  string `json:"login_id"`
	Username string `json:"username"`

	// Presence of the other user.
	Online     bool    `json:"online"`
	LastSeenAt *string `json:"last_seen_at"`
}

type ChatsResponse struct {
	Chats []Chat `json:"chats"`
}

func loginWithCredentials(username, password string) (*LoginResponse, error) {
	var result LoginResponse

	if err := authRequest("/api/auth/login", username, password, &result); err != nil {
		return nil, err
	}

	if result.Token == "" {
		return nil, fmt.Errorf(
			"server did not return authentication token",
		)
	}

	return &result, nil
}

func registerWithCredentials(username, password string) (*LoginResponse, error) {
	var result LoginResponse

	if err := authRequest("/api/auth/register", username, password, &result); err != nil {
		return nil, err
	}

	if result.Token != "" {
		return &result, nil
	}

	// Older backends do not return a token on registration.
	return loginWithCredentials(username, password)
}

func logout(token string) error {
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/auth/logout", nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+token)

	return doJSON(req, nil)
}

// authRequest posts credentials to an auth endpoint and decodes the
// response into out (if out is not nil).
func authRequest(
	endpoint string,
	username string,
	password string,
	out any,
) error {
	body, err := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	req, err := http.NewRequest(
		http.MethodPost,
		serverURL+endpoint,
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	return doJSON(req, out)
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
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("server connection failed: %w", err)
	}

	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read server response: %w", err)
	}

	if resp.StatusCode == http.StatusUnauthorized &&
		req.Header.Get("Authorization") != "" {
		return errSessionExpired
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var serverError struct {
			Message string `json:"message"`
			Error   string `json:"error"`
		}

		if json.Unmarshal(responseBody, &serverError) == nil {
			if serverError.Message != "" {
				return fmt.Errorf("%s", serverError.Message)
			}

			if serverError.Error != "" {
				return fmt.Errorf("%s", serverError.Error)
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
		ID         string  `json:"id"`
		LoginID    string  `json:"login_id"`
		Username   string  `json:"username"`
		Online     bool    `json:"online"`
		LastSeenAt *string `json:"last_seen_at"`
	} `json:"user"`
}

// createChat opens (or returns the existing) direct chat with the user
// that has the given login ID.
func createChat(token, loginID string) (Chat, error) {
	var result createChatResponse

	err := authorizedPost(token, "/api/chats", map[string]string{
		"login_id": loginID,
	}, &result)
	if err != nil {
		return Chat{}, fmt.Errorf("failed to create chat: %w", err)
	}

	return Chat{
		ID:       result.Chat.ID,
		Type:     result.Chat.Type,
		Created:  result.Chat.Created,
		UserID:   result.User.ID,
		LoginID:  result.User.LoginID,
		Username: result.User.Username,

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
