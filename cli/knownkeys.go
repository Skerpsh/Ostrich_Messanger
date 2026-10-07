package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

// The public key each contact had when this computer first saw it, by the
// contact's user ID; one file per account in the user's config directory
// (e.g. ~/.config/ostrich/known-keys-<id>.json). A different key later
// means the contact set up a new account key, or the server is swapping
// keys to read the chat: the CLI then asks to compare the safety code.

var userIDRE = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func knownKeysPath(ownID string) (string, bool) {
	dir, err := os.UserConfigDir()

	// The ID comes from the server: never let it name another file.
	if err != nil || !userIDRE.MatchString(ownID) {
		return "", false
	}

	return filepath.Join(dir, "ostrich", "known-keys-"+ownID+".json"), true
}

// loadKnownKeys returns the remembered keys; empty if there are none or
// the file cannot be read.
func loadKnownKeys(ownID string) map[string]string {
	keys := map[string]string{}

	path, ok := knownKeysPath(ownID)
	if !ok {
		return keys
	}

	data, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(data, &keys)
	}

	return keys
}

// saveKnownKeys writes the keys, readable only by the user. Errors are
// ignored: the check then starts over next time.
func saveKnownKeys(ownID string, keys map[string]string) {
	path, ok := knownKeysPath(ownID)
	if !ok {
		return
	}

	data, err := json.Marshal(keys)
	if err != nil || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}

	// Written next to the file and renamed, so it is never half written.
	tmp := path + ".tmp"

	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

// checkPeerKeys remembers the keys of chats seen for the first time and
// marks the users whose key differs from the remembered one.
func (m *tuiModel) checkPeerKeys() {
	if m.user == nil {
		return
	}

	changed := map[string]bool{}
	added := false

	for _, chat := range m.chats {
		if chat.PublicKey == "" {
			continue
		}

		known, ok := m.knownKeys[chat.UserID]

		switch {
		case !ok:
			m.knownKeys[chat.UserID] = chat.PublicKey
			added = true
		case known != chat.PublicKey:
			changed[chat.UserID] = true
		}
	}

	m.keyChanged = changed

	if added {
		saveKnownKeys(m.user.User.ID, m.knownKeys)
	}
}

// acceptPeerKey: the user has compared the safety code of the new key.
func (m *tuiModel) acceptPeerKey(chat Chat) {
	m.knownKeys[chat.UserID] = chat.PublicKey
	delete(m.keyChanged, chat.UserID)
	saveKnownKeys(m.user.User.ID, m.knownKeys)
}
