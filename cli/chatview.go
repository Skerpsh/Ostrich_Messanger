package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

// Drawing the open chat: header, message bubbles, banners, composer.

// Messages of one sender closer than this are drawn as one group.
const groupGap = 5 * time.Minute

// lineMeta tells what a line of the messages area shows: a message
// (index; -1 for separators) and whether it is the quote of a reply.
type lineMeta struct {
	message int
	quote   bool
}

type chatLinesResult struct {
	text []string
	meta []lineMeta
}

// chatLines draws all loaded messages for a chat of width w.
func (m model) chatLines(w int) chatLinesResult {
	c := m.chat
	p := m.pal
	chat, _ := m.chatByID(c.id)
	var out chatLinesResult

	add := func(line string, meta lineMeta) {
		out.text = append(out.text, line)
		out.meta = append(out.meta, meta)
	}

	separator := lineMeta{message: -1}
	unread := m.unreadLine()
	content := w - 2
	shown := m.shown()

	for i, message := range shown {
		var prev *Message

		if i > 0 {
			prev = &shown[i-1]
		}

		at := parseTime(&message.CreatedAt)
		newDay := prev == nil || at == nil || dayOf(parseTime(&prev.CreatedAt)) != dayOf(at)

		if newDay {
			add(blank(w, p.bg), separator)
			add(center(seg(" "+formatDayLabel(message.CreatedAt)+" ", p.muted, p.panel), w, p.bg), separator)
		}

		if i == unread {
			label := seg(" Unread messages ", p.accent, p.bg)
			rule := max((content-width(label))/2, 0)
			add(blank(1, p.bg)+seg(strings.Repeat("─", rule), p.accent, p.bg)+label+
				seg(strings.Repeat("─", max(content-rule-width(label), 0)), p.accent, p.bg)+blank(1, p.bg), separator)
		}

		// A group event: a line in the middle.
		if message.Kind == "system" {
			if !newDay {
				add(blank(w, p.bg), separator)
			}

			text := clip(sanitize(systemText(message.SenderID, message.SenderUsername, message.Content, m.user.User.ID)), w-4)
			add(center(seg(" "+text+" ", p.muted, p.panel), w, p.bg), lineMeta{message: i})

			continue
		}

		grouped := !newDay && i != unread && prev != nil && prev.SenderID == message.SenderID &&
			prev.Kind != "system" && at != nil && at.Sub(*parseTime(&prev.CreatedAt)) < groupGap

		if !grouped && !newDay {
			add(blank(w, p.bg), separator)
		}

		// Groups: who wrote it, over the first of their bubbles.
		if chat.Type == "group" && !grouped && message.SenderID != m.user.User.ID {
			name := "@" + sanitize(m.memberName(message.SenderID, message.SenderUsername))
			add(blank(2, p.bg)+bold(clip(name, content-2), avatarColor(name), p.bg), lineMeta{message: i})
		}

		for _, line := range m.bubble(chat, message, content) {
			add(line.text, lineMeta{message: i, quote: line.quote})
		}
	}

	return out
}

func dayOf(t *time.Time) string {
	if t == nil {
		return ""
	}

	return t.Local().Format("2006-01-02")
}

type bubbleLine struct {
	text  string
	quote bool
}

// bubble draws one message, aligned in a line of w cells plus a 1-cell
// margin on each side (the left one marks the selected message).
func (m model) bubble(chat Chat, message Message, w int) []bubbleLine {
	c := m.chat
	p := m.pal
	own := message.SenderID == m.user.User.ID
	selected := c.selecting && c.selectedID == message.ID
	sending := m.outgoingState(message.ID)
	highlighted := c.highlight == message.ID
	read := own && chat.PeerLastReadAt != nil && !later(&message.CreatedAt, chat.PeerLastReadAt)

	var reactions []string

	for _, r := range message.Reactions {
		reactions = append(reactions, r.Emoji+r.UserID)
	}

	edited := ""

	if message.EditedAt != nil {
		edited = *message.EditedAt
	}

	key := strings.Join([]string{
		message.ID, message.Content, edited, strings.Join(reactions, ","),
		fmt.Sprint(read, w, p.mode, p.accent, chat.PublicKey, sending),
	}, "|")

	body, ok := c.cache[key]

	if !ok {
		body = m.drawBubble(chat, message, own, read, sending, w)
		c.cache[key] = body
	}

	marker := blank(1, p.bg)

	switch {
	case selected:
		marker = seg("▌", p.accent, p.bg)
	case highlighted:
		marker = seg("▌", p.textSoft, p.bg)
	}

	lines := make([]bubbleLine, len(body))
	quoteLines := 0

	if message.ReplyTo != nil {
		// Top edge, then the two quote lines.
		quoteLines = 3
	}

	for i, line := range body {
		lines[i] = bubbleLine{
			text:  marker + line + blank(1, p.bg),
			quote: i > 0 && i < quoteLines,
		}
	}

	return lines
}

// drawBubble draws the bubble itself, aligned in w cells.
func (m model) drawBubble(chat Chat, message Message, own, read bool, sending string, w int) []string {
	p := m.pal
	fill, fg, meta := p.panel, p.text, p.muted

	if own {
		fill, fg, meta = p.accent, p.onAccent, p.onAccent
	}

	maxInner := max(min(w*72/100, 64), 12)
	shown := m.show(chat, message.ID, message.SenderID, message.Content)
	text, status := sanitize(shown.text), shown.status

	var content []string

	// The quoted message.
	if reply := message.ReplyTo; reply != nil {
		quote := oneLine(sanitize(plainText(m.textOf(chat, reply.ID, reply.SenderID, reply.Content))))
		name := bold(clip(m.quoteSender(reply), maxInner-2), fg, fill)

		if reply.SenderIsDeveloper {
			name += blank(1, fill) + devBadge()
		}

		content = append(content,
			seg("▎", fg, fill)+name,
			seg("▎", fg, fill)+seg(clip(quote, maxInner-1), meta, fill),
		)
	}

	for _, a := range shown.attachments {
		icon := "📎 "

		if isImage(a.Mime) {
			icon = "🖼 "
		}

		label := icon + clip(sanitize(a.Name), maxInner-14) + " · " + formatSize(a.Size)
		content = append(content, bold(clip(label, maxInner), fg, fill))
	}

	if shown.forwardedFrom != "" {
		forwardFg := p.accent

		if own {
			forwardFg = fg
		}

		content = append(content, bold(clip("Forwarded from @"+sanitize(shown.forwardedFrom), maxInner), forwardFg, fill))
	}

	switch {
	case status == decryptOK && strings.TrimSpace(text) == "" && len(shown.attachments) > 0:
		// Only files.
	case status == decryptOK:
		codeBg, linkFg := p.panelAlt, p.accent

		if own {
			codeBg, linkFg = lipgloss.Color(blend(string(p.onAccent), string(p.accent), 0.18)), fg
		}

		content = append(content, markupLines(text, maxInner, fg, fill, codeBg, linkFg)...)
	case status == decryptFailed:
		for _, line := range wrap(text, maxInner) {
			content = append(content, italic(line, meta, fill))
		}
	default:
		for _, line := range wrap(text, maxInner) {
			content = append(content, seg(line, fg, fill))
		}
	}

	if len(message.Reactions) > 0 {
		content = append(content, m.reactionChips(message.Reactions, fg, fill))
	}

	// not encrypted · edited · 14:05 ✓✓
	var info []string

	if status == decryptPlain {
		info = append(info, "🔓 not encrypted")
	}

	if message.EditedAt != nil {
		info = append(info, "edited")
	}

	info = append(info, formatTime(message.CreatedAt))
	metaLine := seg(strings.Join(info, " · "), meta, fill)

	switch {
	case sending == "failed":
		metaLine += blank(1, fill) + bold("⚠ Not sent", meta, fill)
	case sending != "":
		metaLine += blank(1, fill) + seg("🕓", meta, fill)
	case own:
		tick := "✓"

		if read {
			tick = "✓✓"
		}

		metaLine += blank(1, fill) + bold(tick, meta, fill)
	}

	inner := width(metaLine)

	for _, line := range content {
		inner = max(inner, width(line))
	}

	inner = min(inner, maxInner)

	lines := []string{seg("▗"+strings.Repeat("▄", inner+2)+"▖", fill, p.bg)}

	for _, line := range content {
		lines = append(lines, blank(2, fill)+fitLine(line, inner, fill)+blank(2, fill))
	}

	lines = append(lines,
		blank(2, fill)+alignRight(metaLine, inner, fill)+blank(2, fill),
		seg("▝"+strings.Repeat("▀", inner+2)+"▘", fill, p.bg),
	)

	pad := w - (inner + 4)

	for i, line := range lines {
		if own {
			lines[i] = blank(pad, p.bg) + line
		} else {
			lines[i] = line + blank(pad, p.bg)
		}
	}

	return lines
}

// reactionChips: "👍 2  🔥", the user's own underlined.
func (m model) reactionChips(reactions []Reaction, fg, bg lipgloss.Color) string {
	counts := map[string]int{}
	mine := map[string]bool{}
	var order []string

	for _, r := range reactions {
		if counts[r.Emoji] == 0 {
			order = append(order, r.Emoji)
		}

		counts[r.Emoji]++

		if r.UserID == m.user.User.ID {
			mine[r.Emoji] = true
		}
	}

	var chips []string

	for _, emoji := range order {
		label := emoji

		if counts[emoji] > 1 {
			label += fmt.Sprintf(" %d", counts[emoji])
		}

		style := lipgloss.NewStyle().Foreground(fg).Background(bg)

		if mine[emoji] {
			style = style.Underline(true).Bold(true)
		}

		chips = append(chips, style.Render(label))
	}

	return strings.Join(chips, blank(2, bg))
}

// --- chrome ---

// chatBanners are the lines between the messages and the composer.
func (m model) chatBanners(chat Chat, w int) []string {
	c := m.chat
	p := m.pal
	bg := p.surface
	var lines []string

	closeButton := zone.Mark("chat:cancel", seg(" ✕ ", p.muted, bg))

	switch {
	case chat.Type == "group" && m.groupDistrusted[chat.ID] && m.groupKeyOf(chat.ID, chat.KeyEpoch) == nil:
		lines = append(lines, fitLine(seg(" ⚠ "+clip("The group's key came from someone whose security key has changed. Compare safety codes (Ctrl+G)", w-4), p.danger, bg), w, bg))
	case chat.Type == "group" && m.groupKeyOf(chat.ID, chat.KeyEpoch) == nil:
		lines = append(lines, fitLine(seg(" "+clip("Loading the group's key…", w-2), p.muted, bg), w, bg))
	case chat.Type != "group" && chat.PublicKey == "" && !chat.Blocked:
		lines = append(lines, fitLine(seg(" "+clip("@"+sanitize(chat.Username)+" has not set up end-to-end encryption yet", w-2), p.muted, bg), w, bg))
	}

	if chat.Type != "group" && m.keyChanged[chat.UserID] {
		lines = append(lines, zone.Mark("chat:keywarning", fitLine(
			seg(" ⚠ ", p.danger, bg)+seg(clip("The security key of @"+sanitize(chat.Username)+" has changed. ", w-30), p.text, bg)+
				bold("Compare the safety code", p.accent, bg), w, bg)))
	}

	if c.err != "" {
		lines = append(lines, zone.Mark("chat:error", row(seg(" "+clip(sanitize(c.err), w-6), p.danger, bg), seg(" ✕ ", p.danger, bg), w, bg)))
	}

	if c.attaching {
		input := seg(" 📎 ", p.accent, bg) + seg("▌", p.accent, p.panelAlt) +
			fitLine(onBackground(c.attach.View(), p.panelAlt), w-6, p.panelAlt)
		lines = append(lines, fitLine(input, w, bg))
	}

	for i, file := range c.picked {
		icon := "📎 "

		if isImage(file.mime) {
			icon = "🖼 "
		}

		status := formatSize(file.size)

		if c.uploading {
			status = "uploading…"
		}

		left := seg(" "+icon, p.accent, bg) + bold(clip(sanitize(file.name), w/2), p.text, bg) + seg("  "+status, p.muted, bg)
		lines = append(lines, row(left, zone.Mark(fmt.Sprintf("chat:unpick:%d", i), seg(" ✕ ", p.muted, bg)), w, bg))
	}

	if c.editing != nil {
		text := oneLine(sanitize(m.textOf(chat, c.editing.ID, c.editing.SenderID, c.editing.Content)))
		lines = append(lines, row(seg(" ✎ ", p.accent, bg)+bold("Edit message ", p.accent, bg)+seg(text, p.muted, bg), closeButton, w, bg))
	}

	if c.replyTo != nil {
		name := "yourself"

		if c.replyTo.SenderID != m.user.User.ID {
			name = sanitize(c.replyTo.SenderUsername)
		}

		text := oneLine(sanitize(m.textOf(chat, c.replyTo.ID, c.replyTo.SenderID, c.replyTo.Content)))
		lines = append(lines, row(seg(" ↪ ", p.accent, bg)+bold("Reply to "+name+" ", p.accent, bg)+seg(text, p.muted, bg), closeButton, w, bg))
	}

	return lines
}

// chatChromeHeight is everything of the chat except the messages area.
func (m model) chatChromeHeight() int {
	c := m.chat
	chat, _ := m.chatByID(c.id)
	h := 3 // header

	if chat.PinnedMessage != nil {
		h++
	}

	if c.searching {
		h += 2
	}

	h += len(m.chatBanners(chat, m.paneWidth()))

	if chat.Blocked {
		return h + 4
	}

	// Space, the input, the hints.
	return h + c.composer.Height() + 2
}

func (m model) chatView(w, h int) string {
	c := m.chat
	p := m.pal
	chat, _ := m.chatByID(c.id)
	var lines []string

	lines = append(lines, m.chatHeader(chat, w)...)

	if pinned := chat.PinnedMessage; pinned != nil {
		bg := p.surface
		text := oneLine(sanitize(plainText(m.textOf(chat, pinned.ID, pinned.SenderID, pinned.Content))))
		left := seg(" ▎", p.accent, bg) + bold("Pinned  ", p.accent, bg) + seg(text, p.textSoft, bg)
		lines = append(lines, row(zone.Mark("chat:pinned", left), zone.Mark("chat:unpin", seg(" ✕ ", p.muted, bg)), w, bg))
	}

	if c.searching {
		lines = append(lines, m.chatSearchBar(w), seg(strings.Repeat("─", w), p.line, p.surface))
	}

	// Messages.
	area := m.chatAreaHeight()
	var messages string

	switch {
	case !c.loaded:
		messages = fitBlock(strings.Repeat("\n", area/2)+center(seg("Loading…", p.muted, p.bg), w, p.bg), w, area, p.bg)
	case len(m.shown()) == 0:
		card := []string{
			center(bold("  No messages yet  ", p.text, p.panel), w, p.bg),
			center(seg("  "+m.sayHi(chat)+"  ", p.muted, p.panel), w, p.bg),
		}
		messages = fitBlock(strings.Repeat("\n", max(area/2-1, 0))+strings.Join(card, "\n"), w, area, p.bg)
	default:
		all := m.chatLines(w)
		start, end := m.chatWindow(len(all.text))
		visible := all.text[start:end]

		// Few messages: they sit at the bottom.
		for len(visible) < area {
			visible = append([]string{blank(w, p.bg)}, visible...)
		}

		messages = strings.Join(visible, "\n")
	}

	lines = append(lines, zone.Mark("chat:messages", fitBlock(messages, w, area, p.bg)))
	lines = append(lines, m.chatBanners(chat, w)...)
	lines = append(lines, m.composerView(chat, w)...)

	return fitBlock(strings.Join(lines, "\n"), w, h, p.surface)
}

// chatHeader: back (narrow), avatar, name, status; search, safety code,
// menu. Three lines with the divider.
func (m model) chatHeader(chat Chat, w int) []string {
	c := m.chat
	p := m.pal
	bg := p.surface

	left := blank(1, bg)

	if !m.wide() {
		left = zone.Mark("chat:back", seg(" ‹ ", p.accent, bg))
	}

	group := chat.Type == "group"
	name := bold(sanitize(m.chatName(chat)), p.text, bg)

	if group {
		name = zone.Mark("chat:groupinfo", seg("👥 ", p.muted, bg)+name)
	}

	if chat.IsDeveloper {
		name += blank(1, bg) + devBadge()
	}

	// Groups: the group's screen instead of the safety code.
	middle := iconButton("chat:safety", "🛡", p.textSoft, bg)

	if group {
		middle = iconButton("chat:groupinfo", "👥", p.textSoft, bg)
	}

	right := iconButton("chat:search", "🔍", p.textSoft, bg) + middle +
		iconButton("chat:menu", "⋮", p.textSoft, bg)

	var status string

	switch {
	case m.connStatus == connConnecting:
		status = seg("connecting…", p.muted, bg)
	case m.connStatus == connOffline:
		status = seg("waiting for network…", p.muted, bg)
	case m.isTyping(c.id):
		status = seg(m.typingText(chat), p.accent, bg)
	case group:
		status = seg(m.membersText(chat), p.muted, bg)
	case m.presence[chat.UserID].online:
		status = seg("online", p.online, bg)
	default:
		pr := m.presence[chat.UserID]
		status = seg(formatPresence(&pr, time.Now()), p.muted, bg)
	}

	if chat.Pinned {
		status += seg("  📌", p.muted, bg)
	}

	if chat.Muted {
		status += seg("  🔕", p.muted, bg)
	}

	indent := width(left) + 4

	return []string{
		row(left+avatar(m.chatName(chat))+blank(1, bg)+name, right, w, bg),
		fitLine(blank(indent, bg)+status, w, bg),
		seg(strings.Repeat("─", w), p.line, bg),
	}
}

func (m model) chatSearchBar(w int) string {
	c := m.chat
	p := m.pal
	bg := p.surface
	matches := m.matches()
	count := ""

	switch {
	case strings.TrimSpace(c.search.Value()) == "":
	case len(matches) == 0:
		count = "0"
	default:
		count = fmt.Sprintf("%d/%d", c.matchIndex+1, len(matches))
	}

	right := seg(count+" ", p.muted, bg)

	if c.hasMore {
		label := "load older"

		if c.loadingOlder {
			label = "loading…"
		}

		right += zone.Mark("chat:older", seg(label, p.accent, bg)) + blank(1, bg)
	}

	right += zone.Mark("chat:searchclose", seg(" ✕ ", p.muted, bg))

	box := seg(" 🔍 ", p.muted, p.panelAlt) + fitLine(onBackground(c.search.View(), p.panelAlt), max(w-width(right)-8, 4), p.panelAlt)

	return row(blank(1, bg)+box, right, w, bg)
}

// composerView: the input with the send button and the key hints; or the
// bar that replaces it when either has blocked the other.
func (m model) composerView(chat Chat, w int) []string {
	c := m.chat
	p := m.pal
	bg := p.surface

	if chat.Blocked {
		lines := []string{blank(w, bg)}

		if chat.BlockedByMe {
			lines = append(lines,
				center(seg("You blocked @"+sanitize(chat.Username), p.muted, bg), w, bg),
				center(zone.Mark("chat:unblock", bold(" Unblock ", p.text, p.panelAlt)), w, bg),
			)
		} else {
			lines = append(lines, center(seg("You can't message @"+sanitize(chat.Username), p.muted, bg), w, bg), blank(w, bg))
		}

		return append(lines, blank(w, bg))
	}

	inputW := w - 8
	inputLines := strings.Split(onBackground(c.composer.View(), p.panelAlt), "\n")
	sendFg, sendBg := p.muted, p.panelAlt

	if strings.TrimSpace(c.composer.Value()) != "" && !c.sending {
		sendFg, sendBg = p.onAccent, p.accent
	}

	icon := "➤"

	if c.editing != nil {
		icon = "✓"
	}

	var box []string

	for i, line := range inputLines {
		send := blank(3, bg)

		if i == len(inputLines)-1 {
			send = zone.Mark("chat:send", bold(" "+icon+" ", sendFg, sendBg))
		}

		box = append(box, blank(1, bg)+blank(1, p.panelAlt)+fitLine(line, inputW, p.panelAlt)+
			blank(1, p.panelAlt)+blank(1, bg)+send+blank(1, bg))
	}

	composer := zone.Mark("chat:composer", strings.Join(box, "\n"))

	hints := "Enter Send  ↑ Messages  Ctrl+A Attach  Ctrl+O Menu  Ctrl+F Search  Ctrl+K Safety code  Alt+Enter New line  Esc Back"

	if chat, _ := m.chatByID(c.id); chat.Type == "group" {
		hints = "Enter Send  ↑ Messages  Ctrl+A Attach  Ctrl+G Group  Ctrl+O Menu  Ctrl+F Search  Alt+Enter New line  Esc Back"
	}

	switch {
	case c.attaching:
		hints = "Type or drop a file's path  Enter Add  Esc Cancel"
	case len(c.picked) > 0:
		hints = "Enter Send with the files  Ctrl+A Another  Ctrl+X Remove the last  Esc Back"
	case c.selecting:
		hints = "↑↓ Choose  Enter Menu  r Reply  e Edit  d Delete  c Copy  1–8 React  Esc Back"
	case c.searching:
		hints = "Enter/↑ Older match  ↓ Newer match  Ctrl+L Load older  Esc Close search"
	}

	return []string{
		blank(w, bg),
		composer,
		m.hintLine(hints, w, bg),
	}
}
