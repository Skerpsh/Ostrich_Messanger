package main

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
	qrcode "github.com/skip2/go-qrcode"
)

// Invite links to groups (opening one asks to join; an admin lets people
// in), profile links, and QR codes of them drawn in the terminal; the same
// as the app's (frontend/src/lib/links.ts).

// webURL is the web app's address, for links (OSTRICH_WEB).
var webURL = strings.TrimRight(envOr("OSTRICH_WEB", defaultWebURL), "/")

const defaultWebURL = "https://62.238.111.55.nip.io"

func inviteLink(token string) string { return webURL + "/chats/join/" + token }

func profileLink(username string) string { return webURL + "/chats/u/" + url.PathEscape(username) }

var (
	joinLinkRE    = regexp.MustCompile(`/chats/join/([A-Za-z0-9_-]{16,64})/?$`)
	profileLinkRE = regexp.MustCompile(`/chats/u/([A-Za-z0-9_.-]{3,32})/?$`)
)

// parseLink reads an invite or profile link (of any web address).
func parseLink(text string) (kind, value string) {
	text = strings.TrimSpace(text)

	if m := joinLinkRE.FindStringSubmatch(text); m != nil {
		return "join", m[1]
	}

	if m := profileLinkRE.FindStringSubmatch(text); m != nil {
		return "user", m[1]
	}

	return "", ""
}

// --- API ---

func getInvite(token, chatID string) (string, error) {
	var result struct {
		Token *string `json:"token"`
	}

	if err := authorizedGet(token, chatPath(chatID)+"/invite", &result); err != nil || result.Token == nil {
		return "", err
	}

	return *result.Token, nil
}

func makeInvite(token, chatID string) (string, error) {
	var result struct {
		Token string `json:"token"`
	}

	err := authorizedJSON(token, http.MethodPut, chatPath(chatID)+"/invite", nil, &result)

	return result.Token, err
}

func removeInvite(token, chatID string) error {
	return authorizedJSON(token, http.MethodDelete, chatPath(chatID)+"/invite", nil, nil)
}

type inviteInfo struct {
	ChatID      *string `json:"chat_id"`
	InvitedBy   *string `json:"invited_by"`
	MemberCount int     `json:"member_count"`
	// "member", "requested" or "none".
	Status string `json:"status"`
}

func getInviteInfo(token, invite string) (inviteInfo, error) {
	var result struct {
		Invite inviteInfo `json:"invite"`
	}

	err := authorizedGet(token, "/api/invites/"+url.PathEscape(invite), &result)

	return result.Invite, err
}

func requestToJoin(token, invite string) error {
	return authorizedPost(token, "/api/invites/"+url.PathEscape(invite)+"/request", map[string]any{}, nil)
}

func cancelJoinRequest(token, invite string) error {
	return authorizedJSON(token, http.MethodDelete, "/api/invites/"+url.PathEscape(invite)+"/request", nil, nil)
}

func getJoinRequests(token, chatID string) ([]foundUser, error) {
	var result struct {
		Requests []foundUser `json:"requests"`
	}

	err := authorizedGet(token, chatPath(chatID)+"/requests", &result)

	return result.Requests, err
}

func declineJoinRequest(token, chatID, userID string) error {
	return authorizedJSON(token, http.MethodDelete, chatPath(chatID)+"/requests/"+url.PathEscape(userID), nil, nil)
}

// --- the group's link (admins) ---

// inviteMenu loads the group's link and shows what can be done with it.
func (m *model) inviteMenu(chat Chat) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		invite, err := getInvite(token, chat.ID)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			m.openMenu(m.inviteMenuFor(chat, invite))

			return nil
		}
	})
}

func (m *model) inviteMenuFor(chat Chat, invite string) *menuState {
	create := menuItem{icon: "✚", label: "Make an invite link", action: func(m *model) tea.Cmd {
		return m.changeInvite(chat, true)
	}}

	if invite == "" {
		return &menuState{title: "No invite link yet. Whoever opens one asks to join; an admin lets them in.",
			items: []menuItem{create}, confirming: -1}
	}

	link := inviteLink(invite)
	create.label = "New link (the old one stops working)"

	return &menuState{title: link, confirming: -1, items: []menuItem{
		{icon: "⧉", label: "Copy the link", action: func(m *model) tea.Cmd {
			if err := copyText(link); err != nil {
				return m.fail(err)
			}

			return m.showToast("Copied", false)
		}},
		{icon: "▦", label: "Show its QR code", action: func(m *model) tea.Cmd {
			m.qr = &qrState{title: "Invite to " + m.chatName(chat), text: link}
			return nil
		}},
		create,
		{icon: "🗑", label: "Remove the link", danger: true, confirm: "Remove? It stops working",
			action: func(m *model) tea.Cmd { return m.changeInvite(chat, false) }},
	}}
}

func (m *model) changeInvite(chat Chat, renew bool) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		var invite string
		var err error

		if renew {
			invite, err = makeInvite(token, chat.ID)
		} else {
			err = removeInvite(token, chat.ID)
		}

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			m.openMenu(m.inviteMenuFor(chat, invite))

			return nil
		}
	})
}

// requestsMenu: who asks to join; letting someone in hands them the key.
func (m *model) requestsMenu(chat Chat) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		requests, err := getJoinRequests(token, chat.ID)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			var items []menuItem

			for _, request := range requests {
				request := request
				items = append(items, menuItem{icon: "?", label: "@" + request.Username, action: func(m *model) tea.Cmd {
					m.openMenu(&menuState{title: "@" + request.Username + " asks to join", confirming: -1, items: []menuItem{
						{icon: "✓", label: "Let in", action: func(m *model) tea.Cmd { return m.letIn(chat, request) }},
						{icon: "✕", label: "Decline", danger: true, action: func(m *model) tea.Cmd {
							return m.groupChange(func(token string) (func(*model), error) {
								return nil, declineJoinRequest(token, chat.ID, request.ID)
							}, "Declined")
						}},
					}})

					return nil
				}})
			}

			if len(items) == 0 {
				items = append(items, menuItem{icon: " ", label: "Nobody is asking", action: func(*model) tea.Cmd { return nil }})
			}

			m.openMenu(&menuState{title: "Asking to join " + m.chatName(chat), items: items, confirming: -1})

			return nil
		}
	})
}

// letIn adds a user who asked, with the group's key wrapped for them.
func (m *model) letIn(chat Chat, user foundUser) tea.Cmd {
	key := m.groupKeyOf(chat.ID, chat.KeyEpoch)
	if key == nil {
		return m.fail(errGroupKeyMissing)
	}

	privateKey := m.user.PrivateKey

	return m.groupChange(func(token string) (func(*model), error) {
		keys, err := wrapFor(key, chat.KeyEpoch, chat.ID, privateKey, []foundUser{user})
		if err != nil {
			return nil, err
		}

		return nil, authorizedPost(token, chatPath(chat.ID)+"/members", map[string]any{
			"user_id":     user.ID,
			"wrapped_key": keys[0].WrappedKey,
			"epoch":       chat.KeyEpoch,
		}, nil)
	}, "@"+user.Username+" let in")
}

// --- opening a link ---

// openLink opens a pasted invite or profile link.
func (m *model) openLink(kind, value string) tea.Cmd {
	if kind == "user" {
		if strings.EqualFold(value, m.user.User.Username) {
			return m.openSaved()
		}

		return m.messageMember(value)
	}

	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		info, err := getInviteInfo(token, value)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if info.Status == "member" && info.ChatID != nil {
				if chat, ok := m.chatByID(*info.ChatID); ok {
					return m.openChat(chat)
				}
			}

			title := fmt.Sprintf("An invite to a group of %d members", info.MemberCount)

			if info.InvitedBy != nil {
				title = fmt.Sprintf("@%s invites you to a group of %d members", *info.InvitedBy, info.MemberCount)
			}

			title += ". Its name and messages show once an admin lets you in."

			var item menuItem

			if info.Status == "requested" {
				item = menuItem{icon: "✕", label: "Take the request back", action: func(m *model) tea.Cmd {
					return m.joinAction(func(token string) error { return cancelJoinRequest(token, value) }, "Request taken back")
				}}
			} else {
				item = menuItem{icon: "✚", label: "Ask to join", action: func(m *model) tea.Cmd {
					return m.joinAction(func(token string) error { return requestToJoin(token, value) }, "Asked: an admin lets you in")
				}}
			}

			m.openMenu(&menuState{title: title, items: []menuItem{item}, confirming: -1})

			return nil
		}
	})
}

func (m *model) joinAction(work func(token string) error, done string) tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		err := work(token)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			return m.showToast(done, false)
		}
	})
}

// --- QR codes ---

// qrState is a QR code shown over the screen.
type qrState struct {
	title, text string
}

// qrLines draws a QR code with half blocks (two modules per line), dark
// on white with the quiet zone, as scanners need it.
func qrLines(text string) ([]string, error) {
	code, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return nil, err
	}

	bits := code.Bitmap()
	style := lipgloss.NewStyle().Foreground(lipgloss.Color("#000000")).Background(lipgloss.Color("#ffffff"))
	var lines []string

	for y := 0; y < len(bits); y += 2 {
		var b strings.Builder

		for x := range bits[y] {
			top := bits[y][x]
			bottom := y+1 < len(bits) && bits[y+1][x]

			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}

		lines = append(lines, style.Render(b.String()))
	}

	return lines, nil
}

func (m model) qrView() string {
	p := m.pal
	bg := p.panel
	lines, err := qrLines(m.qr.text)
	inner := 0

	for _, line := range lines {
		inner = max(inner, width(line))
	}

	inner = max(inner, min(56, m.width-8))
	out := []string{bold(clip(m.qr.title, inner), p.text, bg), ""}

	if err != nil {
		out = append(out, seg(clip(err.Error(), inner), p.danger, bg))
	} else {
		for _, line := range lines {
			out = append(out, center(line, inner, bg))
		}
	}

	out = append(out, "", center(seg(clip(m.qr.text, inner), p.accent, bg), inner, bg), "",
		seg(clip("Scan it with a phone's camera.  Esc Close", inner), p.muted, bg))

	return zone.Mark("qr", m.card(out, inner+4))
}
