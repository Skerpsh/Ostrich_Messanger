package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Groups, the same as the app's (frontend/src/lib/groups.ts): a key per
// epoch wrapped for each member (group_crypto.go), the name and photo
// encrypted with it, the messages the server writes about the group, and
// the changes members make.

const maxGroupMembers = 50

// resetGroups forgets the groups' keys (new session, logging out).
func (m *model) resetGroups() {
	m.groupKeys = map[string]map[int][]byte{}
	m.groupKeysLoading = map[string]bool{}
	m.groupDistrusted = map[string]bool{}
	m.members = nil
}

// --- API ---

// foundUser is a user found by @username, with their public key.
type foundUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	PublicKey   string `json:"public_key"`
	IsDeveloper bool   `json:"is_developer"`
}

type groupMember struct {
	foundUser
	Role string `json:"role"`
}

type wrappedGroupKey struct {
	Epoch            int    `json:"epoch"`
	WrappedKey       string `json:"wrapped_key"`
	WrapperID        string `json:"wrapper_id"`
	WrapperPublicKey string `json:"wrapper_public_key"`
}

type memberKey struct {
	UserID     string `json:"user_id"`
	WrappedKey string `json:"wrapped_key"`
}

type groupRotation struct {
	Epoch         int         `json:"epoch"`
	Keys          []memberKey `json:"keys"`
	EncryptedInfo string      `json:"encrypted_info"`
}

func findUser(token, username string) (foundUser, error) {
	var result struct {
		User foundUser `json:"user"`
	}

	err := authorizedGet(token, "/api/users/by-username/"+url.PathEscape(username), &result)

	return result.User, err
}

func getGroupMembers(token, chatID string) ([]groupMember, error) {
	var result struct {
		Members []groupMember `json:"members"`
	}

	err := authorizedGet(token, chatPath(chatID)+"/members", &result)

	return result.Members, err
}

func getGroupKeys(token, chatID string) ([]wrappedGroupKey, error) {
	var result struct {
		Keys []wrappedGroupKey `json:"keys"`
	}

	err := authorizedGet(token, chatPath(chatID)+"/keys", &result)

	return result.Keys, err
}

func setGroupRole(token, chatID, userID, role string) error {
	return authorizedJSON(token, http.MethodPut, chatPath(chatID)+"/members/"+url.PathEscape(userID)+"/role",
		map[string]string{"role": role}, nil)
}

// removeGroupMemberAPI removes a member (with the next key) or leaves
// (rotation nil).
func removeGroupMemberAPI(token, chatID, userID string, rotation *groupRotation) error {
	var body any

	if rotation != nil {
		body = rotation
	}

	return authorizedJSON(token, http.MethodDelete, chatPath(chatID)+"/members/"+url.PathEscape(userID), body, nil)
}

// loadMembers loads the open group's members (names, presence, the
// group's screen).
func (m *model) loadMembers() tea.Cmd {
	if m.user == nil || m.chat == nil {
		return nil
	}

	chat, ok := m.chatByID(m.chat.id)
	if !ok || chat.Type != "group" {
		m.members = nil
		return nil
	}

	token := m.user.Token
	chatID := chat.ID

	return task(func() func(*model) tea.Cmd {
		members, err := getGroupMembers(token, chatID)

		return func(m *model) tea.Cmd {
			if err == nil && m.chat != nil && m.chat.id == chatID {
				m.members = members

				if m.menu != nil && m.menu.groupInfo == chatID {
					if chat, ok := m.chatByID(chatID); ok {
						cursor := m.menu.cursor
						m.menu = m.groupInfoMenu(chat)
						m.menu.cursor = min(cursor, len(m.menu.items)-1)
					}
				}
			}

			return nil
		}
	})
}

// memberName is a group member's username, from the members list.
func (m model) memberName(userID, fallback string) string {
	for _, member := range m.members {
		if member.ID == userID {
			return member.Username
		}
	}

	return fallback
}

// --- keys ---

// The group's key of an epoch, if this user has it.
func (m model) groupKeyOf(chatID string, epoch int) []byte {
	return m.groupKeys[chatID][epoch]
}

func (m *model) addGroupKey(chatID string, epoch int, key []byte) {
	if m.groupKeys[chatID] == nil {
		m.groupKeys[chatID] = map[int][]byte{}
	}

	m.groupKeys[chatID][epoch] = key
}

// unwrapGroupKeys keeps the keys wrapped for this user. A key counts only
// if whoever wrapped it still has the account key this computer knows
// them by (knownkeys.go): otherwise the server could hand out a key of its
// own and read what is written with it.
func (m *model) unwrapGroupKeys(chatID string, wrapped []wrappedGroupKey) {
	own, _ := publicKeyOf(m.user.PrivateKey)
	added := false

	for _, item := range wrapped {
		if m.groupKeyOf(chatID, item.Epoch) != nil {
			continue
		}

		if item.WrapperPublicKey != own && item.WrapperID != "" {
			known, ok := m.knownKeys[item.WrapperID]

			switch {
			case !ok:
				m.knownKeys[item.WrapperID] = item.WrapperPublicKey
				added = true
			case known != item.WrapperPublicKey:
				m.groupDistrusted[chatID] = true
				continue
			}
		}

		key, err := unwrapGroupKey(item.WrappedKey, item.Epoch, chatID, m.user.PrivateKey, m.user.User.ID, item.WrapperPublicKey)
		if err == nil {
			m.addGroupKey(chatID, item.Epoch, key)
		}
	}

	if added {
		saveKnownKeys(m.user.User.ID, m.knownKeys)
	}
}

// loadGroupKeys fetches the keys of the groups whose current key is
// missing.
func (m *model) loadGroupKeys() tea.Cmd {
	if m.user == nil {
		return nil
	}

	var cmds []tea.Cmd

	for _, chat := range m.chats {
		if chat.Type != "group" || m.groupKeyOf(chat.ID, chat.KeyEpoch) != nil || m.groupKeysLoading[chat.ID] {
			continue
		}

		chatID := chat.ID
		token := m.user.Token
		m.groupKeysLoading[chatID] = true

		cmds = append(cmds, task(func() func(*model) tea.Cmd {
			keys, err := getGroupKeys(token, chatID)

			return func(m *model) tea.Cmd {
				if m.user == nil || m.user.Token != token {
					return nil
				}

				delete(m.groupKeysLoading, chatID)

				if err == nil {
					m.unwrapGroupKeys(chatID, keys)
				}

				return nil
			}
		}))
	}

	return tea.Batch(cmds...)
}

// --- name ---

func (m model) groupInfoOf(chat Chat) (groupInfo, bool) {
	if chat.Type != "group" || chat.EncryptedInfo == "" {
		return groupInfo{}, false
	}

	return decryptGroupInfo(chat.EncryptedInfo, func(epoch int) []byte { return m.groupKeyOf(chat.ID, epoch) }, chat.ID)
}

// chatName is what a chat is called: the other user's username, or the
// group's name.
func (m model) chatName(chat Chat) string {
	if chat.Type != "group" {
		return chat.Username
	}

	if info, ok := m.groupInfoOf(chat); ok {
		return info.Name
	}

	return "Group"
}

// chatTitle: "@user", or the group's name.
func (m model) chatTitle(chat Chat) string {
	if chat.Type == "group" {
		return m.chatName(chat)
	}

	return "@" + chat.Username
}

// --- system messages ---

type systemUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type systemEvent struct {
	Type  string       `json:"type"`
	Users []systemUser `json:"users"`
	User  *systemUser  `json:"user"`
	Role  string       `json:"role"`
}

// systemText is what a message the server wrote about a group says, e.g.
// "@ann added @bob".
func systemText(senderID, senderUsername, content, ownID string) string {
	name := func(u systemUser) string {
		if u.ID == ownID {
			return "you"
		}

		return "@" + u.Username
	}

	names := func(users []systemUser) string {
		var parts []string

		for _, u := range users {
			parts = append(parts, name(u))
		}

		return strings.Join(parts, ", ")
	}

	actor := "@" + senderUsername

	if senderID == ownID {
		actor = "You"
	}

	var event systemEvent

	if json.Unmarshal([]byte(content), &event) != nil {
		return "Group changed"
	}

	switch event.Type {
	case "created":
		return actor + " created the group"
	case "added":
		return actor + " added " + names(event.Users)
	case "removed":
		return actor + " removed " + names(event.Users)
	case "left":
		return actor + " left the group"
	case "role":
		if event.User == nil {
			break
		}

		if event.Role == "admin" {
			return actor + " made " + name(*event.User) + " an admin"
		}

		return actor + " made " + name(*event.User) + " a member"
	case "info":
		return actor + " changed the group's name or photo"
	case "owner":
		if event.User == nil {
			break
		}

		if event.User.ID == ownID {
			return "You are now the owner"
		}

		return "@" + event.User.Username + " is now the owner"
	}

	return "Group changed"
}

// --- changes ---

var errGroupKeyMissing = errors.New("the group's key has not loaded yet")

func withPublicKeys(users []foundUser) error {
	for _, u := range users {
		if u.PublicKey == "" {
			return fmt.Errorf("@%s has not set up end-to-end encryption yet", u.Username)
		}
	}

	return nil
}

// wrapFor wraps a key of the group for these members.
func wrapFor(key []byte, epoch int, chatID string, privateKey []byte, members []foundUser) ([]memberKey, error) {
	if err := withPublicKeys(members); err != nil {
		return nil, err
	}

	keys := make([]memberKey, 0, len(members))

	for _, member := range members {
		wrapped, err := wrapGroupKey(key, epoch, chatID, privateKey, member.ID, member.PublicKey)
		if err != nil {
			return nil, err
		}

		keys = append(keys, memberKey{UserID: member.ID, WrappedKey: wrapped})
	}

	return keys, nil
}

// createGroup creates a group with these members; returns its id and key.
func createGroup(token string, me foundUser, privateKey []byte, name string, members []foundUser) (string, []byte, error) {
	id := newMessageID()
	key := newGroupKey()

	keys, err := wrapFor(key, 1, id, privateKey, append([]foundUser{me}, members...))
	if err != nil {
		return "", nil, err
	}

	err = authorizedPost(token, "/api/groups", map[string]any{
		"id":             id,
		"encrypted_info": encryptGroupInfo(groupInfo{Name: name}, key, 1, id),
		"keys":           keys,
	}, nil)

	return id, key, err
}

// nextGroupKey makes the group's next key for these members, with the info
// encrypted with it.
func nextGroupKey(chat Chat, info groupInfo, privateKey []byte, members []foundUser) (*groupRotation, []byte, error) {
	epoch := chat.KeyEpoch + 1
	key := newGroupKey()

	keys, err := wrapFor(key, epoch, chat.ID, privateKey, members)
	if err != nil {
		return nil, nil, err
	}

	return &groupRotation{Epoch: epoch, Keys: keys, EncryptedInfo: encryptGroupInfo(info, key, epoch, chat.ID)}, key, nil
}

func memberUsers(members []groupMember, except string) []foundUser {
	var users []foundUser

	for _, member := range members {
		if member.ID != except {
			users = append(users, member.foundUser)
		}
	}

	return users
}

// groupChange runs a change of the group in the background, then reloads
// the chats and the group's members.
func (m *model) groupChange(work func(token string) (func(*model), error), done string) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		apply, err := work(token)

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				return m.fail(err)
			}

			if apply != nil {
				apply(m)
			}

			cmds := []tea.Cmd{m.loadChats(), m.loadMembers()}

			if done != "" {
				cmds = append(cmds, m.showToast(done, false))
			}

			return tea.Batch(cmds...)
		}
	})
}

// rotateKey makes the group's next key (an admin wants one, or someone
// left).
func (m *model) rotateKey(chat Chat) tea.Cmd {
	info, ok := m.groupInfoOf(chat)
	if !ok {
		return m.fail(errGroupKeyMissing)
	}

	privateKey := m.user.PrivateKey

	return m.groupChange(func(token string) (func(*model), error) {
		members, err := getGroupMembers(token, chat.ID)
		if err != nil {
			return nil, err
		}

		rotation, key, err := nextGroupKey(chat, info, privateKey, memberUsers(members, ""))
		if err != nil {
			return nil, err
		}

		if err := authorizedPost(token, chatPath(chat.ID)+"/keys", rotation, nil); err != nil {
			return nil, err
		}

		return func(m *model) { m.addGroupKey(chat.ID, rotation.Epoch, key) }, nil
	}, "The group has a new key")
}

func (m *model) addMember(chat Chat, username string) tea.Cmd {
	key := m.groupKeyOf(chat.ID, chat.KeyEpoch)
	if key == nil {
		return m.fail(errGroupKeyMissing)
	}

	privateKey := m.user.PrivateKey

	return m.groupChange(func(token string) (func(*model), error) {
		user, err := findUser(token, username)
		if err != nil {
			return nil, err
		}

		keys, err := wrapFor(key, chat.KeyEpoch, chat.ID, privateKey, []foundUser{user})
		if err != nil {
			return nil, err
		}

		return nil, authorizedPost(token, chatPath(chat.ID)+"/members", map[string]any{
			"user_id":     user.ID,
			"wrapped_key": keys[0].WrappedKey,
			"epoch":       chat.KeyEpoch,
		}, nil)
	}, "@"+username+" added")
}

// removeMember removes a member; the others get the next key right away.
func (m *model) removeMember(chat Chat, member groupMember) tea.Cmd {
	info, ok := m.groupInfoOf(chat)
	if !ok {
		return m.fail(errGroupKeyMissing)
	}

	privateKey := m.user.PrivateKey

	return m.groupChange(func(token string) (func(*model), error) {
		members, err := getGroupMembers(token, chat.ID)
		if err != nil {
			return nil, err
		}

		rotation, key, err := nextGroupKey(chat, info, privateKey, memberUsers(members, member.ID))
		if err != nil {
			return nil, err
		}

		if err := removeGroupMemberAPI(token, chat.ID, member.ID, rotation); err != nil {
			return nil, err
		}

		return func(m *model) { m.addGroupKey(chat.ID, rotation.Epoch, key) }, nil
	}, "@"+member.Username+" removed")
}

func (m *model) setRole(chat Chat, member groupMember, role string) tea.Cmd {
	return m.groupChange(func(token string) (func(*model), error) {
		return nil, setGroupRole(token, chat.ID, member.ID, role)
	}, "")
}

// renameGroup changes the group's name (its photo stays).
func (m *model) renameGroup(chat Chat, name string) tea.Cmd {
	key := m.groupKeyOf(chat.ID, chat.KeyEpoch)
	info, ok := m.groupInfoOf(chat)

	if key == nil || !ok {
		return m.fail(errGroupKeyMissing)
	}

	info.Name = name

	return m.groupChange(func(token string) (func(*model), error) {
		return nil, authorizedJSON(token, http.MethodPut, chatPath(chat.ID)+"/info", map[string]string{
			"encrypted_info": encryptGroupInfo(info, key, chat.KeyEpoch, chat.ID),
		}, nil)
	}, "Renamed")
}

func (m *model) leaveGroup(chat Chat) tea.Cmd {
	userID := m.user.User.ID

	return m.groupChange(func(token string) (func(*model), error) {
		if err := removeGroupMemberAPI(token, chat.ID, userID, nil); err != nil {
			return nil, err
		}

		return func(m *model) {
			if i := m.findChat(chat.ID); i >= 0 {
				m.chats = append(m.chats[:i], m.chats[i+1:]...)
			}

			if m.chat != nil && m.chat.id == chat.ID {
				m.closeChat()
			}
		}, nil
	}, "You left the group")
}

// reencryptForGroup: the server refused a group message because the
// group's key changed (or has to: someone left) since it was encrypted.
// Makes the new key if needed and returns the message encrypted again.
//
// keys: the group's keys the model has; known: the model's known keys
// (a copy), to check who wrapped new ones, as unwrapGroupKeys does.
func reencryptForGroup(token string, me Account, privateKey []byte, keys map[int][]byte, known map[string]string, message Message) (string, map[int][]byte, error) {
	keyOf := func(epoch int) []byte { return keys[epoch] }
	text, status := decryptGroupMessage(message.Content, message.ID, me.ID, keyOf, message.ChatID)

	if status != decryptOK {
		return "", nil, errors.New("this message can no longer be sent")
	}

	chats, err := getChats(token)
	if err != nil {
		return "", nil, err
	}

	var chat *Chat

	for i := range chats {
		if chats[i].ID == message.ChatID {
			chat = &chats[i]
		}
	}

	if chat == nil || chat.Type != "group" {
		return "", nil, errors.New("you are no longer in this group")
	}

	wrapped, err := getGroupKeys(token, chat.ID)
	if err != nil {
		return "", nil, err
	}

	fresh := map[int][]byte{}

	for epoch, key := range keys {
		fresh[epoch] = key
	}

	own, _ := publicKeyOf(privateKey)

	for _, item := range wrapped {
		trusted := item.WrapperPublicKey == own || item.WrapperID == "" ||
			known[item.WrapperID] == "" || known[item.WrapperID] == item.WrapperPublicKey

		if fresh[item.Epoch] == nil && trusted {
			if key, err := unwrapGroupKey(item.WrappedKey, item.Epoch, chat.ID, privateKey, me.ID, item.WrapperPublicKey); err == nil {
				fresh[item.Epoch] = key
			}
		}
	}

	epoch := chat.KeyEpoch

	if chat.RotationNeeded {
		info, ok := decryptGroupInfo(chat.EncryptedInfo, func(e int) []byte { return fresh[e] }, chat.ID)
		if !ok {
			return "", nil, errGroupKeyMissing
		}

		members, err := getGroupMembers(token, chat.ID)
		if err != nil {
			return "", nil, err
		}

		rotation, key, err := nextGroupKey(*chat, info, privateKey, memberUsers(members, ""))
		if err != nil {
			return "", nil, err
		}

		if err := authorizedPost(token, chatPath(chat.ID)+"/keys", rotation, nil); err != nil {
			return "", nil, err
		}

		epoch = rotation.Epoch
		fresh[epoch] = key
	}

	key := fresh[epoch]
	if key == nil {
		return "", nil, errGroupKeyMissing
	}

	return encryptGroupMessage(text, message.ID, me.ID, key, epoch, chat.ID), fresh, nil
}
