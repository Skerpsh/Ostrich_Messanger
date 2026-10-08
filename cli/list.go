package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

// The chats list: search, starting chats by @username, unread counts,
// "typing…", the chat menu (pin, mute, clear, delete).

const (
	// Lines of a chat in the list: name, preview, space.
	listRowHeight = 3
	// Header (title, status, space, search, space) and hint line.
	listHeaderHeight = 5
)

type listState struct {
	// The highlighted row and the first row shown.
	cursor, top int

	searching bool
	search    textinput.Model

	// Starting a chat with the searched @username.
	starting bool

	// Messages matching the search (search.go).
	matches []messageMatch
}

func newListState(p palette) listState {
	// Long enough for a pasted link.
	return listState{search: newInput("Search, @username or a link", 200, false, p)}
}

func (l *listState) restyle(p palette) {
	styleInput(&l.search, p)
}

func (l *listState) resize(w int) {
	l.search.Width = max(w-8, 4)
}

// listRow is a chat, the offer to start one with the searched name, a
// pasted link to open, or a message found by the search.
type listRow struct {
	chat     *Chat
	username string

	linkKind, linkValue string
	match               *messageMatch
}

// query is the search text, without "@", in lower case.
func (l listState) query() string {
	return strings.ToLower(cleanUsername(l.search.Value()))
}

func (m model) listRows() []listRow {
	query := m.list.query()
	var rows []listRow

	if kind, value := parseLink(m.list.search.Value()); kind != "" {
		return []listRow{{linkKind: kind, linkValue: value}}
	}

	if m.canStartChat(query) {
		rows = append(rows, listRow{username: query})
	}

	for i := range m.chats {
		if query == "" || strings.Contains(strings.ToLower(m.chatName(m.chats[i])), query) {
			rows = append(rows, listRow{chat: &m.chats[i]})
		}
	}

	for i := range m.list.matches {
		rows = append(rows, listRow{match: &m.list.matches[i]})
	}

	return rows
}

// canStartChat: the search is a username that is not in the list.
func (m model) canStartChat(query string) bool {
	if !validUsername(query) || m.user == nil || strings.EqualFold(query, m.user.User.Username) {
		return false
	}

	for _, chat := range m.chats {
		if chat.Type != "group" && strings.EqualFold(chat.Username, query) {
			return false
		}
	}

	return true
}

func (l listState) selectedChatID(m model) string {
	rows := m.listRows()

	if l.cursor < len(rows) && rows[l.cursor].chat != nil {
		return rows[l.cursor].chat.ID
	}

	return ""
}

// selectChat puts the cursor on the chat (if it is listed).
func (l *listState) selectChat(m model, chatID string) {
	rows := m.listRows()

	for i, row := range rows {
		if row.chat != nil && row.chat.ID == chatID {
			l.cursor = i
			return
		}
	}

	l.cursor = min(l.cursor, max(len(rows)-1, 0))
}

func (m *model) moveListCursor(delta int) {
	rows := m.listRows()

	if len(rows) == 0 {
		return
	}

	m.list.cursor = min(max(m.list.cursor+delta, 0), len(rows)-1)
}

// visibleRows is how many chats fit in the list.
func (m model) visibleRows() int {
	return max((m.height-listHeaderHeight-1)/listRowHeight, 1)
}

// scrollList keeps the cursor on screen.
func (m *model) scrollList() {
	n := m.visibleRows()

	if m.list.cursor < m.list.top {
		m.list.top = m.list.cursor
	}

	if m.list.cursor >= m.list.top+n {
		m.list.top = m.list.cursor - n + 1
	}

	m.list.top = max(min(m.list.top, len(m.listRows())-n), 0)
}

func (m *model) startSearch(prefix string) tea.Cmd {
	m.focus = paneList
	m.list.searching = true
	m.list.search.SetValue(prefix)
	m.list.search.CursorEnd()
	m.list.cursor = 0

	return m.list.search.Focus()
}

func (m *model) stopSearch() {
	m.list.matches = nil
	m.list.searching = false
	m.list.search.SetValue("")
	m.list.search.Blur()
	m.list.cursor = 0

	if m.chat != nil {
		m.list.selectChat(*m, m.chat.id)
	}
}

func (m *model) updateListKey(msg tea.KeyMsg) tea.Cmd {
	l := &m.list
	defer m.scrollList()

	if l.searching {
		switch msg.String() {
		case "esc":
			m.stopSearch()
		case "up":
			m.moveListCursor(-1)
		case "down":
			m.moveListCursor(1)
		case "enter":
			return m.activateRow()
		default:
			var cmd tea.Cmd
			l.search, cmd = l.search.Update(msg)
			l.cursor = 0
			l.matches = m.searchMessages(l.search.Value())

			return cmd
		}

		return nil
	}

	switch msg.String() {
	case "up", "k":
		m.moveListCursor(-1)
	case "down", "j":
		m.moveListCursor(1)
	case "home", "g":
		l.cursor = 0
	case "end", "G":
		m.moveListCursor(len(m.chats))
	case "enter", "right", "l":
		return m.activateRow()
	case "/":
		return m.startSearch("")
	case "n":
		return m.startSearch("@")
	case "N":
		return m.newGroup()
	case "v":
		return m.openSaved()
	case "m", ".":
		rows := m.listRows()

		if l.cursor < len(rows) && rows[l.cursor].chat != nil {
			m.openMenu(m.chatMenu(*rows[l.cursor].chat, false))
		}
	case "s":
		return m.openSettings()
	case "t":
		m.toggleTheme()
	case "tab":
		if m.chat != nil {
			m.focus = paneChat
			return m.chat.composer.Focus()
		}
	case "q":
		return m.quit()
	}

	return nil
}

// activateRow opens the highlighted chat, or starts the chat offered.
func (m *model) activateRow() tea.Cmd {
	rows := m.listRows()

	if m.list.cursor >= len(rows) {
		return nil
	}

	row := rows[m.list.cursor]

	if row.linkKind != "" {
		m.stopSearch()
		return m.openLink(row.linkKind, row.linkValue)
	}

	if row.match != nil {
		match := *row.match
		m.stopSearch()

		return tea.Sequence(m.openChat(match.chat), func() tea.Msg {
			return resultMsg{apply: func(m *model) tea.Cmd { return m.showQuoted(match.message.ID) }}
		})
	}

	if row.chat == nil {
		return m.startChat(row.username)
	}

	chat := *row.chat

	if m.list.searching {
		m.stopSearch()
	}

	return m.openChat(chat)
}

func (m *model) startChat(username string) tea.Cmd {
	if m.list.starting {
		return nil
	}

	m.list.starting = true
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		chat, err := createChat(token, username)

		return func(m *model) tea.Cmd {
			m.list.starting = false

			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				return m.fail(err)
			}

			m.setPresence(chat.UserID, chat.Online, chat.LastSeenAt)

			if m.findChat(chat.ID) < 0 {
				m.moveToTop(chat)
			}

			m.stopSearch()

			return tea.Batch(m.openChat(chat), m.loadChats())
		}
	})
}

func (m *model) updateListMouse(msg tea.MouseMsg) (tea.Cmd, bool) {
	if !m.showingList() {
		return nil, false
	}

	if d := wheel(msg, "list:rows"); d != 0 {
		m.moveListCursor(d)
		m.scrollList()

		return nil, true
	}

	switch {
	case clicked(msg, "list:search"):
		if !m.list.searching {
			return m.startSearch(""), true
		}

		m.focus = paneList

		return nil, true
	case clicked(msg, "list:new"):
		return m.startSearch("@"), true
	case clicked(msg, "list:settings"):
		return m.openSettings(), true
	case clicked(msg, "list:theme"):
		m.toggleTheme()
		return nil, true
	}

	for i, row := range m.listRows() {
		id := fmt.Sprintf("list:row:%d", i)

		switch {
		case clicked(msg, id):
			m.list.cursor = i

			return m.activateRow(), true
		case rightClicked(msg, id) && row.chat != nil:
			m.list.cursor = i
			m.openMenu(m.chatMenu(*row.chat, false))

			return nil, true
		}
	}

	return nil, false
}

// toggleTheme switches between light and dark (leaving "system").
func (m *model) toggleTheme() {
	if m.pal.mode == themeDark {
		m.cfg.Theme = "light"
	} else {
		m.cfg.Theme = "dark"
	}

	m.cfg.save()
	m.applyTheme()
}

// --- view ---

// avatar draws the initial on the user's color.
func avatar(name string) string {
	return lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("#111113")).
		Background(avatarColor(name)).
		Render(" " + initial(name) + " ")
}

// iconButton is a clickable icon.
func iconButton(id, icon string, fg, bg lipgloss.Color) string {
	return zone.Mark(id, seg(" "+icon+" ", fg, bg))
}

func (m model) listView(w, h int) string {
	p := m.pal
	bg := p.surface
	var lines []string

	// Header: own avatar, title, buttons; connection status.
	me := m.user.User.Username
	themeIcon := "☾"

	if p.mode == themeDark {
		themeIcon = "☀"
	}

	left := blank(1, bg) + avatar(me) + blank(1, bg) + bold("Chats", p.text, bg)
	right := iconButton("list:new", "✎", p.accent, bg) +
		iconButton("list:theme", themeIcon, p.textSoft, bg) +
		iconButton("list:settings", "⚙", p.textSoft, bg)

	status := "@" + sanitize(me)

	switch m.connStatus {
	case connConnecting:
		status = "Connecting…"
	case connOffline:
		status = "Waiting for network…"
	}

	if m.user.User.IsDeveloper {
		status += " " + devBadge()
	}

	lines = append(lines,
		row(left, right, w, bg),
		blank(5, bg)+seg(status, p.muted, bg),
		"",
	)

	// Search box.
	searchView := seg(m.list.search.Placeholder, p.muted, p.panelAlt)

	if m.list.searching {
		searchView = onBackground(m.list.search.View(), p.panelAlt)
	}

	searchBox := blank(1, bg) + seg(" 🔍 ", p.muted, p.panelAlt) + fitLine(searchView, w-6, p.panelAlt) + blank(1, bg)
	lines = append(lines, zone.Mark("list:search", searchBox), "")

	// Rows.
	rows := m.listRows()
	area := h - listHeaderHeight - 1
	var rowLines []string

	switch {
	case !m.chatsLoaded:
		rowLines = append(rowLines, "", center(seg("Loading chats…", p.muted, bg), w, bg))
	case len(rows) == 0 && m.list.query() != "":
		rowLines = append(rowLines, "", center(seg(clip("No chats match “"+sanitize(m.list.search.Value())+"”", w-2), p.muted, bg), w, bg))
	case len(rows) == 0:
		rowLines = append(rowLines,
			"",
			center(bold("No chats yet", p.text, bg), w, bg),
			"",
			center(seg("Press n and type a @username,", p.muted, bg), w, bg),
			center(seg("or share yours: @"+sanitize(me), p.muted, bg), w, bg),
		)
	default:
		end := min(m.list.top+m.visibleRows(), len(rows))

		for i := m.list.top; i < end; i++ {
			block := m.listRowView(rows[i], i == m.list.cursor, w)
			rowLines = append(rowLines, zone.Mark(fmt.Sprintf("list:row:%d", i), block))
		}
	}

	rowsBlock := zone.Mark("list:rows", fitBlock(strings.Join(rowLines, "\n"), w, area, bg))
	lines = append(lines, rowsBlock)

	hints := "↑↓ Move  Enter Open  / Search  n New chat  N New group  v Saved  m Menu  s Settings  t Theme  q Quit"

	switch {
	case m.list.searching && w < 60:
		hints = "Enter Open  Esc Cancel"
	case m.list.searching:
		hints = "Type to search, @username to start a chat   Enter Open   Esc Cancel"
	case w < 60:
		hints = "/ Search  n New  m Menu  s Settings  q Quit"
	}

	// Next to a chat or Settings, messages show on their side only.
	if m.wide() && (m.chat != nil || m.settings != nil) {
		lines = append(lines, fitLine(seg(" "+clip(hints, w-2), p.muted, bg), w, bg))
	} else {
		lines = append(lines, m.hintLine(hints, w, bg))
	}

	return fitBlock(strings.Join(lines, "\n"), w, h, bg)
}

// listRowView draws one chat (or the "start a chat" offer): two lines and
// a spacer.
func (m model) listRowView(r listRow, cursor bool, w int) string {
	p := m.pal
	bg := p.surface

	switch {
	case r.chat != nil && m.chat != nil && r.chat.ID == m.chat.id:
		bg = p.accentSoft
	case cursor && (m.focus == paneList || !m.wide()):
		bg = p.hover
	}

	if r.linkKind != "" {
		label, sub := "Open the group invite", "Ask to join; an admin lets you in"

		if r.linkKind == "user" {
			label, sub = "Open @"+r.linkValue+"'s profile", "Start a chat with them"
		}

		return strings.Join([]string{
			row(blank(1, bg)+seg(" 🔗 ", p.onAccent, p.accent)+blank(1, bg)+bold(clip(label, w-8), p.text, bg), "", w, bg),
			blank(5, bg) + seg(clip(sub, w-6), p.muted, bg),
			blank(w, p.surface),
		}, "\n")
	}

	if r.match != nil {
		match := r.match
		who := ""

		switch {
		case match.message.SenderID == m.user.User.ID:
			who = "You: "
		case match.chat.Type == "group":
			who = "@" + match.message.SenderUsername + ": "
		}

		return strings.Join([]string{
			row(blank(1, bg)+seg(" 🔍 ", p.muted, bg)+bold(clip(sanitize(m.chatName(match.chat)), w-16), p.text, bg),
				seg(formatChatDate(match.message.CreatedAt), p.muted, bg)+blank(1, bg), w, bg),
			blank(5, bg) + seg(clip(oneLine(sanitize(who+match.text)), w-6), p.muted, bg),
			blank(w, p.surface),
		}, "\n")
	}

	if r.chat == nil {
		label := "Start a chat with @" + r.username
		sub := "Find this user by their exact username"

		if m.list.starting {
			sub = "Starting…"
		}

		return strings.Join([]string{
			row(blank(1, bg)+seg(" ✚ ", p.onAccent, p.accent)+blank(1, bg)+bold(clip(label, w-8), p.text, bg), "", w, bg),
			blank(5, bg) + seg(clip(sub, w-6), p.muted, bg),
			blank(w, p.surface),
		}, "\n")
	}

	chat := *r.chat
	group := chat.Type == "group"
	name := bold(sanitize(m.chatName(chat)), p.text, bg)

	if group {
		name = seg("👥 ", p.muted, bg) + name
	}

	if chat.Type == "saved" {
		name = seg("🔖 ", p.muted, bg) + name
	}

	if chat.IsDeveloper {
		name += blank(1, bg) + devBadge()
	}

	if chat.Muted {
		name += seg(" 🔕", p.muted, bg)
	}

	if !group && m.keyChanged[chat.UserID] || group && m.groupDistrusted[chat.ID] {
		name += seg(" ⚠", p.danger, bg)
	}

	// Time of the last message, ticks for own messages.
	last := chat.LastMessage
	stamp := chat.Created

	if last != nil {
		stamp = last.CreatedAt
	}

	timeColor := p.muted

	if chat.UnreadCount > 0 {
		timeColor = p.accent
	}

	right := seg(formatChatDate(stamp), timeColor, bg) + blank(1, bg)
	own := last != nil && last.SenderID == m.user.User.ID

	if own && chat.Type != "saved" {
		right = m.ticks(chat, last.CreatedAt, bg) + blank(1, bg) + right
	}

	line1 := row(blank(1, bg)+avatar(m.chatName(chat))+blank(1, bg)+name, right, w, bg)

	// Presence dot under the avatar; preview; pin or unread count.
	dot := blank(3, bg)

	if !group && m.connStatus == connOnline && m.presence[chat.UserID].online {
		dot = seg(" ● ", p.online, bg)
	}

	var preview string
	draft := m.drafts[chat.ID]

	switch {
	case m.isTyping(chat.ID):
		preview = seg("typing…", p.accent, bg)
	case last != nil && last.Kind == "system":
		preview = italic(oneLine(sanitize(systemText(last.SenderID, last.SenderUsername, last.Content, m.user.User.ID))), p.muted, bg)
	case draft != "" && (m.chat == nil || m.chat.id != chat.ID):
		preview = seg("Draft: ", p.danger, bg) + seg(oneLine(sanitize(draft)), p.muted, bg)
	case last == nil:
		preview = italic("No messages yet", p.muted, bg)
	default:
		text := oneLine(sanitize(plainText(m.textOf(chat, last.ID, last.SenderID, last.Content))))

		switch {
		case chat.Type == "saved":
		case own:
			preview = seg("You: ", p.textSoft, bg)
		case group:
			preview = seg("@"+sanitize(last.SenderUsername)+": ", p.textSoft, bg)
		}

		preview += seg(text, p.muted, bg)
	}

	var badge string

	if chat.UnreadMentions > 0 {
		badge += bold(" @ ", p.onAccent, p.accent) + blank(1, bg)
	}

	if chat.JoinRequests > 0 {
		badge += bold(fmt.Sprintf(" +%d ", chat.JoinRequests), p.accent, p.accentSoft) + blank(1, bg)
	}

	switch {
	case chat.UnreadCount > 0:
		count := fmt.Sprint(chat.UnreadCount)

		if chat.UnreadCount > 99 {
			count = "99+"
		}

		fg, badgeBg := p.onAccent, p.accent

		if chat.Muted {
			fg, badgeBg = p.bg, p.muted
		}

		badge += bold(" "+count+" ", fg, badgeBg) + blank(1, bg)
	case chat.Pinned:
		badge += seg("📌", p.muted, bg) + blank(1, bg)
	}

	line2 := row(blank(1, bg)+dot+blank(1, bg)+preview, badge, w, bg)

	return strings.Join([]string{line1, line2, blank(w, p.surface)}, "\n")
}

// ticks: ✓ sent, ✓✓ read by the other member (if read receipts are on).
func (m model) ticks(chat Chat, createdAt string, bg lipgloss.Color) string {
	read := chat.PeerLastReadAt != nil && !later(&createdAt, chat.PeerLastReadAt)

	if read {
		return seg("✓✓", m.pal.accent, bg)
	}

	return seg("✓", m.pal.muted, bg)
}
