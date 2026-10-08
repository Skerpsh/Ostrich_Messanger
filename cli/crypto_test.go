package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The same vectors are checked by frontend/src/lib/crypto.test.ts, so the
// app and the CLI can read each other's messages.
type cryptoVectors struct {
	OstrichID            string   `json:"ostrich_id"`
	AuthKey              string   `json:"auth_key"`
	EncryptedPrivateKeyA string   `json:"encrypted_private_key_a"`
	PrivateKeyA          string   `json:"private_key_a"`
	PublicKeyA           string   `json:"public_key_a"`
	PrivateKeyB          string   `json:"private_key_b"`
	PublicKeyB           string   `json:"public_key_b"`
	ChatID               string   `json:"chat_id"`
	SenderID             string   `json:"sender_id"`
	MessageID            string   `json:"message_id"`
	Text                 string   `json:"text"`
	MessageE2            string   `json:"message_e2"`
	TextE1               string   `json:"text_e1"`
	MessageE1            string   `json:"message_e1"`
	SafetyCode           []string `json:"safety_code"`
}

func loadVectors(t *testing.T) (cryptoVectors, []byte, []byte) {
	t.Helper()

	data, err := os.ReadFile("../testdata/crypto-vectors.json")
	if err != nil {
		t.Fatal(err)
	}

	var v cryptoVectors

	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}

	privateA, err := base64.StdEncoding.DecodeString(v.PrivateKeyA)
	if err != nil {
		t.Fatal(err)
	}

	privateB, err := base64.StdEncoding.DecodeString(v.PrivateKeyB)
	if err != nil {
		t.Fatal(err)
	}

	return v, privateA, privateB
}

func TestAccountKeys(t *testing.T) {
	v, privateA, _ := loadVectors(t)

	id := normalizeOstrichID(strings.ReplaceAll(strings.ToLower(v.OstrichID), "-", " "))
	if id == "" {
		t.Fatal("OstrichID not accepted")
	}

	derived := deriveFromOstrichID(id)

	if derived.authKey != v.AuthKey {
		t.Fatalf("auth key %s, want %s", derived.authKey, v.AuthKey)
	}

	key, err := openPrivateKey(derived, v.EncryptedPrivateKeyA)
	if err != nil || !bytes.Equal(key, privateA) {
		t.Fatalf("private key: %v", err)
	}

	if public, _ := publicKeyOf(privateA); public != v.PublicKeyA {
		t.Fatalf("public key %s, want %s", public, v.PublicKeyA)
	}
}

func TestInvalidOstrichIDs(t *testing.T) {
	for _, input := range []string{"too-short", "0OIL-2222-2222-2222-2222"} {
		if normalizeOstrichID(input) != "" {
			t.Errorf("%q accepted", input)
		}
	}
}

func TestDecryptE2(t *testing.T) {
	v, _, privateB := loadVectors(t)

	text, status := decryptMessage(v.MessageE2, v.MessageID, v.SenderID, privateB, v.PublicKeyA, v.ChatID)
	if status != decryptOK || text != v.Text {
		t.Fatalf("got %q (%d)", text, status)
	}

	other := newMessageID()

	for name, args := range map[string][3]string{
		"sender":  {v.MessageID, other, v.ChatID},
		"message": {other, v.SenderID, v.ChatID},
		"chat":    {v.MessageID, v.SenderID, other},
	} {
		if _, status := decryptMessage(v.MessageE2, args[0], args[1], privateB, v.PublicKeyA, args[2]); status != decryptFailed {
			t.Errorf("other %s accepted", name)
		}
	}
}

func TestDecryptE1(t *testing.T) {
	v, _, privateB := loadVectors(t)

	text, status := decryptMessage(v.MessageE1, newMessageID(), newMessageID(), privateB, v.PublicKeyA, v.ChatID)
	if status != decryptOK || text != v.TextE1 {
		t.Fatalf("got %q (%d)", text, status)
	}
}

func TestPlainText(t *testing.T) {
	v, _, privateB := loadVectors(t)

	if text, status := decryptMessage("hello", v.MessageID, v.SenderID, privateB, v.PublicKeyA, v.ChatID); status != decryptPlain || text != "hello" {
		t.Fatalf("got %q (%d)", text, status)
	}
}

func TestRoundTrip(t *testing.T) {
	v, privateA, privateB := loadVectors(t)
	id := newMessageID()

	content, err := encryptMessage("round trip ✓", id, v.SenderID, privateA, v.PublicKeyB, v.ChatID)
	if err != nil {
		t.Fatal(err)
	}

	if text, status := decryptMessage(content, id, v.SenderID, privateB, v.PublicKeyA, v.ChatID); status != decryptOK || text != "round trip ✓" {
		t.Fatalf("got %q (%d)", text, status)
	}
}

func TestSafetyCode(t *testing.T) {
	v, _, _ := loadVectors(t)

	for _, keys := range [][2]string{{v.PublicKeyA, v.PublicKeyB}, {v.PublicKeyB, v.PublicKeyA}} {
		code, err := safetyCode(keys[0], keys[1])
		if err != nil || !slices.Equal(code, v.SafetyCode) {
			t.Fatalf("got %v, want %v (%v)", code, v.SafetyCode, err)
		}
	}
}

func TestNewMessageID(t *testing.T) {
	uuidV4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

	if id := newMessageID(); !uuidV4.MatchString(id) {
		t.Fatalf("%q is not a UUID v4", id)
	}
}

func TestSanitize(t *testing.T) {
	if got := sanitize("a\x1b[31mb‮c\td\n"); got != "a[31mbc d\n" {
		t.Fatalf("got %q", got)
	}
}

func TestAttachments(t *testing.T) {
	data, err := os.ReadFile("../testdata/crypto-vectors.json")
	if err != nil {
		t.Fatal(err)
	}

	var v struct {
		Key     string `json:"attachment_key"`
		Plain   string `json:"attachment_plain"`
		Sealed  string `json:"attachment_sealed"`
		Payload string `json:"payload_with_attachments"`
	}

	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}

	sealed, _ := base64.StdEncoding.DecodeString(v.Sealed)
	plain, _ := base64.StdEncoding.DecodeString(v.Plain)

	// A file encrypted by the app.
	if got, err := decryptAttachment(sealed, v.Key); err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("app's attachment: %v", err)
	}

	// Round trip, and another key does not open it.
	key, sealedHere := encryptAttachment(plain)

	if got, err := decryptAttachment(sealedHere, key); err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip: %v", err)
	}

	if other, _ := encryptAttachment(plain); other != key {
		if _, err := decryptAttachment(sealedHere, other); err == nil {
			t.Fatal("another key opened the file")
		}
	}

	// The app's payload, read and written back the same.
	p := decodePayload(v.Payload)

	if p.text != "caption" || p.forwardedFrom != "carol" || len(p.attachments) != 1 {
		t.Fatalf("payload: %+v", p)
	}

	if a := p.attachments[0]; a.Name != "photo.jpg" || a.Mime != "image/jpeg" || a.Size != 110 || a.Width != 640 || a.Height != 480 || a.Key != v.Key {
		t.Fatalf("attachment: %+v", a)
	}

	if got := encodePayload(p); got != v.Payload {
		t.Fatalf("written back differently:\n%s\n%s", got, v.Payload)
	}
}
