package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/zalando/go-keyring"
)

// "Remember me": the session is kept between runs, like the web app keeps
// it, so the CLI does not ask for username, password and OstrichID every
// time.
//
// The secrets (the session token and the account's private key, which
// reads every chat) go to the system keyring: Secret Service (GNOME
// Keyring, KWallet) on Linux, the Keychain on macOS, the Credential
// Manager on Windows. Where there is none (e.g. a server over SSH), they
// go to the session file itself, readable only by the user, like SSH
// keys. The session file (~/.config/ostrich/session-<server>.json) also
// keeps the account as last seen, for starting offline.
//
// One session per server (OSTRICH_SERVER), so a local backend and the
// real one do not mix.

const keyringService = "Ostrich CLI"

// keyringTimeout bounds keyring calls: a locked keyring may wait for the
// user to unlock it in a dialog.
const keyringTimeout = 30 * time.Second

var errKeyringTimeout = errors.New("the system keyring did not answer")

type sessionSecrets struct {
	Token      string `json:"token"`
	PrivateKey string `json:"private_key"`
}

type sessionFile struct {
	Server string  `json:"server"`
	User   Account `json:"user"`

	// The secrets are in the keyring; otherwise they are here.
	InKeyring bool            `json:"in_keyring"`
	Secrets   *sessionSecrets `json:"secrets,omitempty"`
}

func sessionPath() (string, bool) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", false
	}

	hash := sha256.Sum256([]byte(serverURL))

	return filepath.Join(dir, "ostrich", "session-"+hex.EncodeToString(hash[:6])+".json"), true
}

// withTimeout runs a keyring call, giving up after keyringTimeout.
func withTimeout(call func() error) error {
	done := make(chan error, 1)

	go func() { done <- call() }()

	select {
	case err := <-done:
		return err
	case <-time.After(keyringTimeout):
		return errKeyringTimeout
	}
}

// saveSession remembers the session; inKeyring tells where the secrets
// went.
func saveSession(result *LoginResponse) (inKeyring bool, err error) {
	path, ok := sessionPath()
	if !ok {
		return false, errors.New("no config directory to keep the session in")
	}

	secrets := sessionSecrets{
		Token:      result.Token,
		PrivateKey: base64.StdEncoding.EncodeToString(result.PrivateKey),
	}

	data, err := json.Marshal(secrets)
	if err != nil {
		return false, err
	}

	file := sessionFile{Server: serverURL, User: result.User}

	if withTimeout(func() error { return keyring.Set(keyringService, serverURL, string(data)) }) == nil {
		file.InKeyring = true
	} else {
		file.Secrets = &secrets
	}

	return file.InKeyring, writeSessionFile(path, file)
}

func writeSessionFile(path string, file sessionFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	// Written next to the file and renamed, so it is never half written.
	tmp := path + ".tmp"

	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

func readSessionFile() (sessionFile, string, bool) {
	var file sessionFile

	path, ok := sessionPath()
	if !ok {
		return file, "", false
	}

	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &file) != nil || file.Server != serverURL {
		return file, path, false
	}

	return file, path, true
}

// loadSession returns the remembered session, or nil.
func loadSession() *LoginResponse {
	file, _, ok := readSessionFile()
	if !ok {
		return nil
	}

	secrets := file.Secrets

	if file.InKeyring {
		var value string

		err := withTimeout(func() (err error) {
			value, err = keyring.Get(keyringService, serverURL)
			return err
		})

		if err != nil || json.Unmarshal([]byte(value), &secrets) != nil {
			return nil
		}
	}

	if secrets == nil || secrets.Token == "" {
		return nil
	}

	privateKey, err := base64.StdEncoding.DecodeString(secrets.PrivateKey)
	if err != nil || len(privateKey) != 32 {
		return nil
	}

	return &LoginResponse{Token: secrets.Token, User: file.User, PrivateKey: privateKey}
}

// updateSavedUser keeps the remembered account up to date (e.g. a new
// username), leaving the secrets as they are.
func updateSavedUser(account Account) {
	file, path, ok := readSessionFile()

	if ok && file.User.ID == account.ID {
		file.User = account
		_ = writeSessionFile(path, file)
	}
}

// forgetSession removes the remembered session, from the keyring too.
func forgetSession() {
	file, path, ok := readSessionFile()

	if ok && file.InKeyring {
		_ = withTimeout(func() error { return keyring.Delete(keyringService, serverURL) })
	}

	if path != "" {
		_ = os.Remove(path)
	}
}
