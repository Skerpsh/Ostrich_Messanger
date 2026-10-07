package main

// End-to-end encryption, the same scheme as frontend/src/lib/crypto.ts
// (see the description there; keep them in step).

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"strings"
	"sync"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
)

const (
	ostrichIDAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	ostrichIDLength   = 20
	messagePrefix     = "e1:"
)

var (
	kdfSalt       = []byte("ostrich/v1")
	privateKeyAAD = []byte("ostrich/v1 private-key")
	chatInfo      = []byte("ostrich/v1 chat")
)

func hkdf32(secret, salt, info []byte) []byte {
	out := make([]byte, 32)

	if _, err := io.ReadFull(hkdf.New(sha256.New, secret, salt, info), out); err != nil {
		panic(err)
	}

	return out
}

func randomBytes(n int) []byte {
	b := make([]byte, n)

	if _, err := rand.Read(b); err != nil {
		panic(err)
	}

	return b
}

// --- OstrichID ---

func generateOstrichID() string {
	var id strings.Builder
	max := big.NewInt(int64(len(ostrichIDAlphabet)))

	for id.Len() < ostrichIDLength {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}

		id.WriteByte(ostrichIDAlphabet[n.Int64()])
	}

	return id.String()
}

// formatOstrichID groups the ID: "K7QM-3XRA-9TPW-H2DC-M8VN".
func formatOstrichID(id string) string {
	var groups []string

	for i := 0; i < len(id); i += 4 {
		groups = append(groups, id[i:min(i+4, len(id))])
	}

	return strings.Join(groups, "-")
}

// normalizeOstrichID returns the canonical form of a typed ID, or "" if it
// cannot be valid.
func normalizeOstrichID(input string) string {
	id := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(input))

	if len(id) != ostrichIDLength {
		return ""
	}

	for _, r := range id {
		if !strings.ContainsRune(ostrichIDAlphabet, r) {
			return ""
		}
	}

	return id
}

// --- account keys ---

type derivedKeys struct {
	authKey string
	wrapKey []byte
}

func deriveFromOstrichID(normalizedID string) derivedKeys {
	ikm := []byte(normalizedID)

	return derivedKeys{
		authKey: hex.EncodeToString(hkdf32(ikm, kdfSalt, []byte("auth"))),
		wrapKey: hkdf32(ikm, kdfSalt, []byte("key-wrap")),
	}
}

// KeyMaterial is what the server stores for an account.
type KeyMaterial struct {
	AuthKey             string `json:"auth_key"`
	PublicKey           string `json:"public_key"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
}

// AccountKeys are an account's keys as the server returns them.
type AccountKeys struct {
	PublicKey           string `json:"public_key"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
}

func createAccountKeys(derived derivedKeys) (KeyMaterial, []byte) {
	privateKey := randomBytes(32)

	publicKey, err := curve25519.X25519(privateKey, curve25519.Basepoint)
	if err != nil {
		panic(err)
	}

	aead, err := chacha20poly1305.NewX(derived.wrapKey)
	if err != nil {
		panic(err)
	}

	nonce := randomBytes(chacha20poly1305.NonceSizeX)
	sealed := aead.Seal(nil, nonce, privateKey, privateKeyAAD)

	return KeyMaterial{
		AuthKey:             derived.authKey,
		PublicKey:           base64.StdEncoding.EncodeToString(publicKey),
		EncryptedPrivateKey: base64.StdEncoding.EncodeToString(append(nonce, sealed...)),
	}, privateKey
}

var errWrongOstrichID = errors.New("wrong OstrichID")

// openPrivateKey decrypts the account's private key; it fails if the
// OstrichID is wrong.
func openPrivateKey(derived derivedKeys, encryptedPrivateKey string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(encryptedPrivateKey)
	if err != nil || len(data) < chacha20poly1305.NonceSizeX {
		return nil, errWrongOstrichID
	}

	aead, err := chacha20poly1305.NewX(derived.wrapKey)
	if err != nil {
		return nil, err
	}

	key, err := aead.Open(nil, data[:chacha20poly1305.NonceSizeX], data[chacha20poly1305.NonceSizeX:], privateKeyAAD)
	if err != nil {
		return nil, errWrongOstrichID
	}

	return key, nil
}

// --- messages ---

var (
	chatKeysMu sync.Mutex
	chatKeys   = map[string][]byte{}
)

func chatKey(privateKey []byte, peerPublicKey, chatID string) ([]byte, error) {
	cacheKey := chatID + ":" + peerPublicKey

	chatKeysMu.Lock()
	defer chatKeysMu.Unlock()

	if key, ok := chatKeys[cacheKey]; ok {
		return key, nil
	}

	peer, err := base64.StdEncoding.DecodeString(peerPublicKey)
	if err != nil {
		return nil, err
	}

	shared, err := curve25519.X25519(privateKey, peer)
	if err != nil {
		return nil, err
	}

	key := hkdf32(shared, []byte(chatID), chatInfo)
	chatKeys[cacheKey] = key

	return key, nil
}

var errNoPeerKey = errors.New("the other user has not set up encryption yet (they need to open the updated Ostrich once)")

func encryptMessage(text string, privateKey []byte, peerPublicKey, chatID string) (string, error) {
	if peerPublicKey == "" {
		return "", errNoPeerKey
	}

	key, err := chatKey(privateKey, peerPublicKey, chatID)
	if err != nil {
		return "", err
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return "", err
	}

	nonce := randomBytes(chacha20poly1305.NonceSizeX)
	sealed := aead.Seal(nil, nonce, []byte(text), []byte(chatID))

	return messagePrefix + base64.StdEncoding.EncodeToString(append(nonce, sealed...)), nil
}

const unreadableMessage = "[can't decrypt this message]"

// textOf decrypts a message of the chat with the signed-in user's key.
func (m tuiModel) textOf(chat Chat, content string) string {
	var privateKey []byte

	if m.user != nil {
		privateKey = m.user.PrivateKey
	}

	return decryptMessage(content, privateKey, chat.PublicKey, chat.ID)
}

// decryptMessage returns the text of a message. Messages from before
// end-to-end encryption are plain text and returned as they are.
func decryptMessage(content string, privateKey []byte, peerPublicKey, chatID string) string {
	if !strings.HasPrefix(content, messagePrefix) {
		return content
	}

	if privateKey == nil || peerPublicKey == "" {
		return unreadableMessage
	}

	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(content, messagePrefix))
	if err != nil || len(data) < chacha20poly1305.NonceSizeX {
		return unreadableMessage
	}

	key, err := chatKey(privateKey, peerPublicKey, chatID)
	if err != nil {
		return unreadableMessage
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return unreadableMessage
	}

	plain, err := aead.Open(nil, data[:chacha20poly1305.NonceSizeX], data[chacha20poly1305.NonceSizeX:], []byte(chatID))
	if err != nil {
		return unreadableMessage
	}

	return string(plain)
}
