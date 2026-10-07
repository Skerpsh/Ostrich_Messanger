package main

// End-to-end encryption, the same scheme as frontend/src/lib/crypto.ts
// (see the description there; keep them in step).

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
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
	messagePrefixV1   = "e1:"
	messagePrefixV2   = "e2:"
	messageAADPrefix  = "ostrich/v2 message"
)

var (
	kdfSalt       = []byte("ostrich/v1")
	privateKeyAAD = []byte("ostrich/v1 private-key")
	chatInfo      = []byte("ostrich/v1 chat")
	safetyInfo    = []byte("ostrich/v1 safety")
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

// clearChatKeys forgets the cached chat keys (on logout).
func clearChatKeys() {
	chatKeysMu.Lock()
	defer chatKeysMu.Unlock()

	chatKeys = map[string][]byte{}
}

func chatKey(privateKey []byte, peerPublicKey, chatID string) ([]byte, error) {
	cacheKey := hex.EncodeToString(privateKey[:8]) + ":" + chatID + ":" + peerPublicKey

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

// messageAAD binds an "e2" message to its chat, sender and id, so the
// server can neither move it to another sender or message nor send it
// again as a new one.
func messageAAD(chatID, senderID, messageID string) []byte {
	return []byte(messageAADPrefix + "\x00" + chatID + "\x00" + senderID + "\x00" + messageID)
}

// newMessageID returns a random UUID (v4) for a new message: the
// encryption is bound to it.
func newMessageID() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)

	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// publicKeyOf returns the base64 public key of a private key.
func publicKeyOf(privateKey []byte) (string, error) {
	public, err := curve25519.X25519(privateKey, curve25519.Basepoint)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(public), nil
}

// safetyCode returns 40 digits in 8 groups, the same for both members of a
// chat: SHA-256 of the two public keys (in a fixed order), each 4 bytes
// taken mod 100000. If both see the same code, the server has not swapped
// the keys.
func safetyCode(publicKeyA, publicKeyB string) ([]string, error) {
	first, second := publicKeyA, publicKeyB

	if second < first {
		first, second = second, first
	}

	a, err := base64.StdEncoding.DecodeString(first)
	if err != nil {
		return nil, err
	}

	b, err := base64.StdEncoding.DecodeString(second)
	if err != nil {
		return nil, err
	}

	input := append(append(append([]byte{}, safetyInfo...), a...), b...)
	hash := sha256.Sum256(input)
	groups := make([]string, 8)

	for i := range groups {
		groups[i] = fmt.Sprintf("%05d", binary.BigEndian.Uint32(hash[i*4:])%100000)
	}

	return groups, nil
}

var errNoPeerKey = errors.New("the other user has not set up encryption yet (they need to open the updated Ostrich once)")

// encryptMessage encrypts a message as "e2"; messageID is a new id
// (newMessageID) or, for an edit, the message's own.
func encryptMessage(text, messageID, senderID string, privateKey []byte, peerPublicKey, chatID string) (string, error) {
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
	sealed := aead.Seal(nil, nonce, []byte(text), messageAAD(chatID, senderID, messageID))

	return messagePrefixV2 + base64.StdEncoding.EncodeToString(append(nonce, sealed...)), nil
}

type decryptStatus int

const (
	decryptOK decryptStatus = iota
	// Not encrypted at all: from before end-to-end encryption, or put
	// there by the server.
	decryptPlain
	decryptFailed
)

const unreadableMessage = "[can't decrypt this message]"

// textOf decrypts a message of the chat with the signed-in user's key.
// Messages that are not encrypted are marked as such.
func (m tuiModel) textOf(chat Chat, messageID, senderID, content string) string {
	var privateKey []byte

	if m.user != nil {
		privateKey = m.user.PrivateKey
	}

	text, status := decryptMessage(content, messageID, senderID, privateKey, chat.PublicKey, chat.ID)

	if status == decryptPlain {
		return "[not encrypted] " + text
	}

	return text
}

// decryptMessage returns the text of an "e2" or "e1" message, or plain
// text as it is (decryptPlain).
func decryptMessage(content, messageID, senderID string, privateKey []byte, peerPublicKey, chatID string) (string, decryptStatus) {
	var aad []byte

	switch {
	case strings.HasPrefix(content, messagePrefixV2):
		aad = messageAAD(chatID, senderID, messageID)
	case strings.HasPrefix(content, messagePrefixV1):
		aad = []byte(chatID)
	default:
		return content, decryptPlain
	}

	if privateKey == nil || peerPublicKey == "" {
		return unreadableMessage, decryptFailed
	}

	// Both prefixes have the same length.
	data, err := base64.StdEncoding.DecodeString(content[len(messagePrefixV2):])
	if err != nil || len(data) < chacha20poly1305.NonceSizeX {
		return unreadableMessage, decryptFailed
	}

	key, err := chatKey(privateKey, peerPublicKey, chatID)
	if err != nil {
		return unreadableMessage, decryptFailed
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return unreadableMessage, decryptFailed
	}

	plain, err := aead.Open(nil, data[:chacha20poly1305.NonceSizeX], data[chacha20poly1305.NonceSizeX:], aad)
	if err != nil {
		return unreadableMessage, decryptFailed
	}

	return string(plain), decryptOK
}
