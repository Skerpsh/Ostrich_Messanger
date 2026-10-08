package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
)

// Group encryption, the same as the app's (frontend/src/lib/crypto.ts,
// see the description there): a group key per epoch, wrapped for every
// member; "e3:<epoch>:…" messages and "i1:<epoch>:…" group info.

var groupWrapInfo = []byte("ostrich/v1 group key-wrap")

const (
	prefixGroup = "e3:"
	prefixInfo  = "i1:"
)

var errBadGroupKey = errors.New("the group key cannot be read")

func newGroupKey() []byte {
	return randomBytes(chacha20poly1305.KeySize)
}

func groupWrapKey(privateKey []byte, otherPublicKey, chatID string) ([]byte, error) {
	other, err := base64.StdEncoding.DecodeString(otherPublicKey)
	if err != nil {
		return nil, err
	}

	shared, err := curve25519.X25519(privateKey, other)
	if err != nil {
		return nil, err
	}

	return hkdf32(shared, []byte(chatID), groupWrapInfo), nil
}

func groupKeyAAD(chatID string, epoch int, memberID string) []byte {
	return []byte(fmt.Sprintf("ostrich/v1 group key\x00%s\x00%d\x00%s", chatID, epoch, memberID))
}

// wrapGroupKey wraps a group key for a member (with their public key).
func wrapGroupKey(groupKey []byte, epoch int, chatID string, privateKey []byte, memberID, memberPublicKey string) (string, error) {
	wrapKey, err := groupWrapKey(privateKey, memberPublicKey, chatID)
	if err != nil {
		return "", err
	}

	aead, err := chacha20poly1305.NewX(wrapKey)
	if err != nil {
		return "", err
	}

	nonce := randomBytes(chacha20poly1305.NonceSizeX)

	return base64.StdEncoding.EncodeToString(aead.Seal(nonce, nonce, groupKey, groupKeyAAD(chatID, epoch, memberID))), nil
}

// unwrapGroupKey unwraps the group key wrapped for this user by the owner
// of wrapperPublicKey.
func unwrapGroupKey(wrapped string, epoch int, chatID string, privateKey []byte, ownID, wrapperPublicKey string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(wrapped)
	if err != nil || len(data) < chacha20poly1305.NonceSizeX {
		return nil, errBadGroupKey
	}

	wrapKey, err := groupWrapKey(privateKey, wrapperPublicKey, chatID)
	if err != nil {
		return nil, errBadGroupKey
	}

	aead, err := chacha20poly1305.NewX(wrapKey)
	if err != nil {
		return nil, errBadGroupKey
	}

	key, err := aead.Open(nil, data[:chacha20poly1305.NonceSizeX], data[chacha20poly1305.NonceSizeX:], groupKeyAAD(chatID, epoch, ownID))
	if err != nil {
		return nil, errBadGroupKey
	}

	return key, nil
}

func groupMessageAAD(chatID, senderID, messageID string, epoch int) []byte {
	return []byte(fmt.Sprintf("ostrich/v3 group message\x00%s\x00%s\x00%s\x00%d", chatID, senderID, messageID, epoch))
}

func sealWith(key, aad, plain []byte) []byte {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		panic(err)
	}

	nonce := randomBytes(chacha20poly1305.NonceSizeX)

	return aead.Seal(nonce, nonce, plain, aad)
}

func encryptGroupMessage(text, messageID, senderID string, groupKey []byte, epoch int, chatID string) string {
	sealed := sealWith(groupKey, groupMessageAAD(chatID, senderID, messageID, epoch), []byte(text))

	return prefixGroup + strconv.Itoa(epoch) + ":" + base64.StdEncoding.EncodeToString(sealed)
}

var (
	groupMessageRE = regexp.MustCompile(`^e3:(\d{1,9}):([A-Za-z0-9+/]+={0,2})$`)
	groupInfoRE    = regexp.MustCompile(`^i1:(\d{1,9}):([A-Za-z0-9+/]+={0,2})$`)
)

// splitEpoch reads "<prefix><epoch>:<base64>".
func splitEpoch(content string, re *regexp.Regexp) (int, []byte, bool) {
	match := re.FindStringSubmatch(content)
	if match == nil {
		return 0, nil, false
	}

	epoch, err := strconv.Atoi(match[1])
	data, err2 := base64.StdEncoding.DecodeString(match[2])

	if err != nil || err2 != nil || len(data) < chacha20poly1305.NonceSizeX {
		return 0, nil, false
	}

	return epoch, data, true
}

func groupMessageEpoch(content string) (int, bool) {
	epoch, _, ok := splitEpoch(content, groupMessageRE)
	return epoch, ok
}

func openWith(key, data, aad []byte) ([]byte, bool) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, false
	}

	plain, err := aead.Open(nil, data[:chacha20poly1305.NonceSizeX], data[chacha20poly1305.NonceSizeX:], aad)

	return plain, err == nil
}

// decryptGroupMessage decrypts an "e3" message with the key of its epoch.
func decryptGroupMessage(content, messageID, senderID string, keyOf func(int) []byte, chatID string) (string, decryptStatus) {
	epoch, data, ok := splitEpoch(content, groupMessageRE)
	if !ok {
		return unreadableMessage, decryptFailed
	}

	key := keyOf(epoch)
	if key == nil {
		return unreadableMessage, decryptFailed
	}

	plain, ok := openWith(key, data, groupMessageAAD(chatID, senderID, messageID, epoch))
	if !ok {
		return unreadableMessage, decryptFailed
	}

	return string(plain), decryptOK
}

// groupInfo is what a group's members see of it; the server never does.
type groupInfo struct {
	Name  string      `json:"name"`
	Photo *groupPhoto `json:"photo,omitempty"`
}

type groupPhoto struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Mime string `json:"mime"`
}

func groupInfoAAD(chatID string, epoch int) []byte {
	return []byte(fmt.Sprintf("ostrich/v1 group info\x00%s\x00%d", chatID, epoch))
}

func encryptGroupInfo(info groupInfo, groupKey []byte, epoch int, chatID string) string {
	data, _ := json.Marshal(info)
	sealed := sealWith(groupKey, groupInfoAAD(chatID, epoch), data)

	return prefixInfo + strconv.Itoa(epoch) + ":" + base64.StdEncoding.EncodeToString(sealed)
}

// decryptGroupInfo returns the group's info, or false if it cannot be
// read (yet).
func decryptGroupInfo(encrypted string, keyOf func(int) []byte, chatID string) (groupInfo, bool) {
	epoch, data, ok := splitEpoch(encrypted, groupInfoRE)
	if !ok {
		return groupInfo{}, false
	}

	key := keyOf(epoch)
	if key == nil {
		return groupInfo{}, false
	}

	plain, ok := openWith(key, data, groupInfoAAD(chatID, epoch))
	if !ok {
		return groupInfo{}, false
	}

	var info groupInfo

	if json.Unmarshal(plain, &info) != nil || info.Name == "" {
		return groupInfo{}, false
	}

	return info, true
}
