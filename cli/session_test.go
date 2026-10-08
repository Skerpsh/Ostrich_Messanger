package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/zalando/go-keyring"
)

func testSession(t *testing.T) *LoginResponse {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	return &LoginResponse{
		Token:      "token-123",
		User:       Account{ID: "33333333-3333-4333-8333-333333333333", Username: "dana"},
		PrivateKey: bytes.Repeat([]byte{7}, 32),
	}
}

func readSaved(t *testing.T) (sessionFile, os.FileInfo) {
	t.Helper()
	path, _ := sessionPath()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(path)

	var file sessionFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}

	return file, info
}

func TestSessionInKeyring(t *testing.T) {
	keyring.MockInit()
	session := testSession(t)

	inKeyring, err := saveSession(session)
	if err != nil || !inKeyring {
		t.Fatalf("saved in keyring: %v %v", inKeyring, err)
	}

	// The file has no secrets.
	if file, _ := readSaved(t); file.Secrets != nil || !file.InKeyring {
		t.Fatalf("secrets in the file: %+v", file)
	}

	loaded := loadSession()

	if loaded == nil || loaded.Token != session.Token || !bytes.Equal(loaded.PrivateKey, session.PrivateKey) ||
		loaded.User.Username != "dana" {
		t.Fatalf("loaded %+v", loaded)
	}

	updateSavedUser(Account{ID: session.User.ID, Username: "dana2"})

	if loaded := loadSession(); loaded == nil || loaded.User.Username != "dana2" {
		t.Fatalf("user not updated: %+v", loaded)
	}

	forgetSession()

	if loadSession() != nil {
		t.Fatal("session still remembered")
	}

	if _, err := keyring.Get(keyringService, serverURL); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("secret still in the keyring: %v", err)
	}
}

func TestSessionWithoutKeyring(t *testing.T) {
	keyring.MockInitWithError(errors.New("no keyring"))
	session := testSession(t)

	inKeyring, err := saveSession(session)
	if err != nil || inKeyring {
		t.Fatalf("saved: %v %v", inKeyring, err)
	}

	file, info := readSaved(t)

	if file.Secrets == nil || file.Secrets.Token != session.Token {
		t.Fatalf("secrets not in the file: %+v", file)
	}

	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", info.Mode().Perm())
	}

	if loaded := loadSession(); loaded == nil || loaded.Token != session.Token {
		t.Fatalf("loaded %+v", loaded)
	}

	forgetSession()

	if loadSession() != nil {
		t.Fatal("session still remembered")
	}
}

func TestSessionPerServer(t *testing.T) {
	keyring.MockInit()
	session := testSession(t)

	if _, err := saveSession(session); err != nil {
		t.Fatal(err)
	}

	previous := serverURL
	serverURL = "http://localhost:3000"
	defer func() { serverURL = previous }()

	if loadSession() != nil {
		t.Fatal("another server's session loaded")
	}
}

func TestRememberedModel(t *testing.T) {
	keyring.MockInit()
	session := testSession(t)

	if _, err := saveSession(session); err != nil {
		t.Fatal(err)
	}

	m := newModel(true, loadSession())

	if m.stage != stageMain || !m.remembered || m.user.Token != session.Token {
		t.Fatalf("not started in the remembered session: stage %d", m.stage)
	}

	// Logging out forgets it.
	cmd := m.signOut("")

	if cmd == nil {
		t.Fatal("no command to forget the session")
	}

	cmd()

	if loadSession() != nil {
		t.Fatal("session still remembered after logging out")
	}
}

func TestRememberMeCheckbox(t *testing.T) {
	m := newModel(true, nil)

	if !m.auth.remember {
		t.Fatal("Remember me is off by default")
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlR})

	if next.(model).auth.remember {
		t.Fatal("Ctrl+R did not turn it off")
	}
}

func TestCacheRoundTrip(t *testing.T) {
	keyring.MockInit()
	m := testModel(t, 120, 34, "dark")
	m.remembered = true
	m.cache = loadCache(m.user.User.ID)

	// Remembered: the chats, the open chat's messages and the outbox are
	// written, and come back at the next start.
	m.saveCache()

	if _, err := saveSession(m.user); err != nil {
		t.Fatal(err)
	}

	next := newModel(true, loadSession())

	if len(next.chats) != len(m.chats) || len(next.outgoing) != len(m.outgoing) {
		t.Fatalf("restored %d chats, %d outgoing", len(next.chats), len(next.outgoing))
	}

	_ = next.openChat(next.chats[0])

	if len(next.chat.messages) != len(m.chat.messages) || !next.chat.loaded {
		t.Fatalf("cached messages not shown: %d", len(next.chat.messages))
	}

	// Logging out removes the cache.
	path, _ := cachePath(m.user.User.ID)
	cmd := next.signOut("")
	cmd()

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cache still there: %v", err)
	}
}
