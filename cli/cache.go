package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The local cache, like the app's: the chats list, the newest messages of
// the chats opened and the outbox, so a remembered session opens at once
// and works offline. Only with "Remember me" (without it the CLI keeps
// nothing). Messages are kept as the server sends them: end-to-end
// encrypted. One file per server and account, readable only by the user;
// removed on logging out.

// How many of a chat's newest messages are kept.
const cachedMessages = 300

// How often changes are written.
const cacheSaveInterval = 10 * time.Second

type cachedOutgoing struct {
	Message Message `json:"message"`
	State   string  `json:"state"`
	Err     string  `json:"error,omitempty"`
}

type cacheFile struct {
	Chats    []Chat               `json:"chats"`
	Messages map[string][]Message `json:"messages"`
	Outbox   []cachedOutgoing     `json:"outbox"`
}

func cachePath(userID string) (string, bool) {
	dir, err := os.UserConfigDir()

	if err != nil || !userIDRE.MatchString(userID) {
		return "", false
	}

	hash := sha256.Sum256([]byte(serverURL))

	return filepath.Join(dir, "ostrich", "cache-"+hex.EncodeToString(hash[:6])+"-"+userID+".json"), true
}

// loadCache returns the account's cache, or an empty one.
func loadCache(userID string) *cacheFile {
	cache := &cacheFile{Messages: map[string][]Message{}}

	if path, ok := cachePath(userID); ok {
		if data, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(data, cache)
		}
	}

	if cache.Messages == nil {
		cache.Messages = map[string][]Message{}
	}

	return cache
}

// writeCache writes the cache; it returns what it wrote, so that an
// unchanged cache is not written again.
func writeCache(userID string, cache *cacheFile, previous []byte) []byte {
	path, ok := cachePath(userID)
	if !ok {
		return previous
	}

	data, err := json.Marshal(cache)
	if err != nil || bytes.Equal(data, previous) || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return previous
	}

	tmp := path + ".tmp"

	if os.WriteFile(tmp, data, 0o600) != nil || os.Rename(tmp, path) != nil {
		return previous
	}

	return data
}

func forgetCache(userID string) {
	if path, ok := cachePath(userID); ok {
		_ = os.Remove(path)
	}
}

// snapshotCache takes the current state into the cache.
func (m *model) snapshotCache() {
	if m.cache == nil {
		return
	}

	m.cache.Chats = m.chats

	if c := m.chat; c != nil && c.loaded {
		messages := c.messages

		if len(messages) > cachedMessages {
			messages = messages[len(messages)-cachedMessages:]
		}

		m.cache.Messages[c.id] = append([]Message(nil), messages...)
	}

	// Chats no longer in the list (deleted, cleared) are forgotten.
	for chatID := range m.cache.Messages {
		if m.chatsLoaded && m.findChat(chatID) < 0 {
			delete(m.cache.Messages, chatID)
		}
	}

	m.cache.Outbox = m.cache.Outbox[:0]

	for _, o := range m.outgoing {
		m.cache.Outbox = append(m.cache.Outbox, cachedOutgoing{Message: o.message, State: o.state, Err: o.err})
	}
}

// saveCache writes the cache if it changed.
func (m *model) saveCache() {
	if m.cache == nil || m.user == nil {
		return
	}

	m.snapshotCache()
	m.cacheWritten = writeCache(m.user.User.ID, m.cache, m.cacheWritten)
}

type cacheTickMsg struct{}

func cacheTick() tea.Cmd {
	return tea.Tick(cacheSaveInterval, func(time.Time) tea.Msg { return cacheTickMsg{} })
}

// restoreCache starts a remembered session from the cache: chats and the
// outbox (sent again once connected).
func (m *model) restoreCache() {
	if m.cache == nil {
		return
	}

	if len(m.cache.Chats) > 0 {
		m.chats = m.cache.Chats
		m.chatsLoaded = true
	}

	for _, o := range m.cache.Outbox {
		state := o.State

		if state != "failed" {
			state = "sending"
		}

		m.outgoing = append(m.outgoing, outgoing{message: o.Message, state: state, err: o.Err})
	}
}
