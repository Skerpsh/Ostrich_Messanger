package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// Files of messages, like the app's: encrypted here before uploading,
// decrypted after downloading (crypto.go); the server only ever has
// ciphertext.

const (
	maxAttachmentBytes = 25 << 20
	maxAttachments     = 10
	// Uploading and downloading 25 MB can take a while.
	attachmentTimeout = 5 * time.Minute
)

var attachmentClient = &http.Client{Timeout: attachmentTimeout}

func attachmentURL(id string) string {
	return serverURL + "/api/attachments/" + url.PathEscape(id)
}

// pickedFile is a file chosen to send with the next message.
type pickedFile struct {
	path string
	name string
	mime string
	size int64
}

// pickFile checks a file the user named (a path, ~ for the home folder).
func pickFile(path string) (pickedFile, error) {
	path = strings.TrimSpace(path)

	// Paths dropped into a terminal often come in quotes.
	path = strings.Trim(path, `'"`)

	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, rest)
		}
	}

	info, err := os.Stat(path)

	switch {
	case err != nil:
		return pickedFile{}, fmt.Errorf("can't open the file: %w", err)
	case info.IsDir():
		return pickedFile{}, fmt.Errorf("that is a folder, not a file")
	case info.Size() > maxAttachmentBytes:
		return pickedFile{}, fmt.Errorf("files can be up to 25 MB")
	case info.Size() == 0:
		return pickedFile{}, fmt.Errorf("the file is empty")
	}

	kind := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))

	if kind == "" {
		head := make([]byte, 512)

		if f, err := os.Open(path); err == nil {
			n, _ := io.ReadFull(f, head)
			f.Close()
			kind = http.DetectContentType(head[:n])
		}
	}

	kind, _, _ = strings.Cut(kind, ";")

	return pickedFile{path: path, name: filepath.Base(path), mime: kind, size: info.Size()}, nil
}

// uploadFile encrypts a picked file and uploads it.
func uploadFile(token string, file pickedFile) (attachment, error) {
	data, err := os.ReadFile(file.path)
	if err != nil {
		return attachment{}, err
	}

	id := newMessageID()
	key, sealed := encryptAttachment(data)

	req, err := http.NewRequest(http.MethodPut, attachmentURL(id), bytes.NewReader(sealed))
	if err != nil {
		return attachment{}, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Ostrich-Client", "cli")

	if err := doAttachmentRequest(req, nil); err != nil {
		return attachment{}, err
	}

	return attachment{ID: id, Key: key, Name: file.name, Mime: file.mime, Size: int64(len(data))}, nil
}

// doAttachmentRequest sends a request with the longer timeout; the body
// (at most one attachment) goes into out.
func doAttachmentRequest(req *http.Request, out *[]byte) error {
	resp, err := attachmentClient.Do(req)
	if err != nil {
		return fmt.Errorf("server connection failed: %w", err)
	}

	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAttachmentBytes+1024))
	if err != nil {
		return fmt.Errorf("failed to read server response: %w", err)
	}

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return errSessionExpired
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return &apiError{status: resp.StatusCode, message: serverMessage(body, resp.StatusCode)}
	}

	if out != nil {
		*out = body
	}

	return nil
}

// serverMessage is the error message of a JSON answer.
func serverMessage(body []byte, status int) string {
	var answer struct {
		Error string `json:"error"`
	}

	if json.Unmarshal(body, &answer) == nil && answer.Error != "" {
		return answer.Error
	}

	return fmt.Sprintf("request failed: HTTP %d", status)
}

// downloadFile downloads and decrypts an attachment.
func downloadFile(token string, a attachment) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, attachmentURL(a.ID), nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Ostrich-Client", "cli")

	var sealed []byte

	if err := doAttachmentRequest(req, &sealed); err != nil {
		return nil, err
	}

	return decryptAttachment(sealed, a.Key)
}

// copyAttachments copies attachments on the server for forwarding: new
// ids, same keys.
func copyAttachments(token string, list []attachment) ([]attachment, error) {
	var copies []attachment

	for _, a := range list {
		id := newMessageID()

		if err := authorizedPost(token, "/api/attachments/"+url.PathEscape(a.ID)+"/copy", map[string]string{"id": id}, nil); err != nil {
			return nil, err
		}

		a.ID = id
		copies = append(copies, a)
	}

	return copies, nil
}

// downloadsDir is where saved files go: ~/Downloads, or the home folder.
func downloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}

	if dir := filepath.Join(home, "Downloads"); isDir(dir) {
		return dir
	}

	return home
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// safeFileName makes a name from another user usable as a file name: no
// folders, no control characters, not hidden.
func safeFileName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}

		return r
	}, name)

	clean = strings.TrimLeft(strings.TrimSpace(clean), ". ")

	if runes := []rune(clean); len(runes) > 120 {
		clean = string(runes[:120])
	}

	if clean == "" {
		return "attachment"
	}

	return clean
}

// saveAttachment writes a decrypted file into dir under a free name
// ("name (2).ext" if taken) and returns its path.
func saveAttachment(dir string, a attachment, data []byte) (string, error) {
	name := safeFileName(a.Name)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)

	for i := 1; i < 1000; i++ {
		candidate := name

		if i > 1 {
			candidate = fmt.Sprintf("%s (%d)%s", base, i, ext)
		}

		path := filepath.Join(dir, candidate)
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)

		if os.IsExist(err) {
			continue
		}

		if err != nil {
			return "", err
		}

		_, err = f.Write(data)

		if closeErr := f.Close(); err == nil {
			err = closeErr
		}

		return path, err
	}

	return "", fmt.Errorf("no free file name for %s", name)
}

func isImage(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}

	return false
}

// formatSize: "1.2 MB".
func formatSize(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%d KB", (n+512)/1024)
	}

	return fmt.Sprintf("%.1f MB", float64(n)/1024/1024)
}

// attachmentsLabel is what a message with files says in previews when it
// has no text.
func attachmentsLabel(list []attachment) string {
	switch {
	case len(list) == 0:
		return ""
	case len(list) == 1 && isImage(list[0].Mime):
		return "🖼 Photo"
	case len(list) == 1:
		return "📎 " + list[0].Name
	}

	for _, a := range list {
		if !isImage(a.Mime) {
			return fmt.Sprintf("📎 %d files", len(list))
		}
	}

	return fmt.Sprintf("🖼 %d photos", len(list))
}
