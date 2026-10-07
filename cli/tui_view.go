package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// Rendering of the login, chats and chat screens.

var (
	logoStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("205")).
			MarginBottom(1)

	inputStyle = lipgloss.NewStyle().
			Width(40).
			Padding(0, 1)

	labelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("245"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("9"))

	successStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("10"))

	hintStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("241"))

	onlineStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("10"))

	selectedChatStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("205"))

	chatBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1, 2)

	messageBoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1, 2)

	ownMessageStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("10"))

	otherMessageStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("205"))
)

func (m tuiModel) View() string {
	switch m.stage {

	case stageLogin:
		return m.loginView()

	case stageChats:
		return m.chatsView()

	case stageChat:
		return m.chatView()

	case stageSettings:
		return m.settingsView()

	case stageOstrichID:
		return m.ostrichIDView()
	}

	return ""
}

func (m tuiModel) loginView() string {
	var b strings.Builder

	b.WriteString("\n")

	b.WriteString(
		logoStyle.Render(
			"╔════════════════════╗\n" +
				"║    OSTRICH CLI     ║\n" +
				"╚════════════════════╝",
		),
	)

	b.WriteString("\n\n")

	if m.loading && m.user != nil {
		action := "Logged in"

		if m.authMode == authRegister {
			action = "Account created"
		}

		b.WriteString(
			successStyle.Render(
				"✓ " + action + " as " + m.user.User.Username,
			),
		)

		b.WriteString("\n\n")
		b.WriteString("Loading chats...")
		b.WriteString("\n")

		return b.String()
	}

	/*
		Authentication mode selector.
	*/

	loginLabel := "Login"
	registerLabel := "Register"

	if m.authMode == authLogin {
		loginLabel = "▶ Login"
	} else {
		registerLabel = "▶ Register"
	}

	if m.authMode == authLogin {
		b.WriteString(
			selectedChatStyle.Render(loginLabel),
		)
	} else {
		b.WriteString(loginLabel)
	}

	b.WriteString("    ")

	if m.authMode == authRegister {
		b.WriteString(
			selectedChatStyle.Render(registerLabel),
		)
	} else {
		b.WriteString(registerLabel)
	}

	b.WriteString("\n\n")

	b.WriteString(labelStyle.Render("Username"))
	b.WriteString("\n")
	b.WriteString(inputStyle.Render(m.username.View()))
	b.WriteString("\n\n")

	b.WriteString(labelStyle.Render("Password"))
	b.WriteString("\n")
	b.WriteString(inputStyle.Render(m.password.View()))
	b.WriteString("\n")

	if m.authMode == authLogin {
		b.WriteString("\n")
		b.WriteString(labelStyle.Render("OstrichID"))
		b.WriteString("\n")
		b.WriteString(inputStyle.Render(m.ostrichIDInput.View()))
		b.WriteString("\n")
	}

	if m.authMode == authRegister {
		b.WriteString("\n")
		b.WriteString(hintStyle.Render(
			"After registration you get an OstrichID: you need it to log in and it\n" +
				"is the key to your end-to-end encrypted messages. It is shown only once.",
		))
		b.WriteString("\n\n")

		b.WriteString(
			labelStyle.Render("Confirm password"),
		)

		b.WriteString("\n")

		b.WriteString(
			inputStyle.Render(
				m.confirmPassword.View(),
			),
		)

		b.WriteString("\n")
	}

	b.WriteString("\n")

	if m.loading {
		if m.authMode == authRegister {
			b.WriteString("Creating account...\n")
		} else {
			b.WriteString("Connecting to Ostrich...\n")
		}
	} else {
		if m.authMode == authRegister {
			b.WriteString(
				hintStyle.Render(
					"Tab Login mode   ↑↓ Field   Enter Register   Esc Back   Ctrl+C Quit",
				),
			)
		} else {
			b.WriteString(
				hintStyle.Render(
					"Tab Register mode   ↑↓ Field   Enter Login   Esc Quit   Ctrl+C Quit",
				),
			)
		}

		b.WriteString("\n")
	}

	if m.notice != "" {
		b.WriteString("\n")
		b.WriteString(successStyle.Render("✓ " + m.notice))
		b.WriteString("\n")
	}

	if m.err != nil {
		b.WriteString("\n")

		b.WriteString(
			errorStyle.Render(
				"Error: " + sanitize(m.err.Error()),
			),
		)

		b.WriteString("\n")
	}

	return b.String()
}

// presenceText renders a user's presence: a green "● online" or a grey
// "last seen ...".
func (m tuiModel) presenceText(userID string) string {
	p, ok := m.presence[userID]

	if !ok {
		return ""
	}

	text := formatPresence(&p, time.Now())

	if p.online {
		return onlineStyle.Render("● " + text)
	}

	return hintStyle.Render(text)
}

func (m tuiModel) chatsView() string {
	var b strings.Builder

	b.WriteString("\n")

	title := "OSTRICH"

	if m.user != nil {
		title += "   @" + sanitize(m.user.User.Username)
	}

	b.WriteString(logoStyle.Render(title))

	if m.user != nil && m.user.User.IsDeveloper {
		b.WriteString(" " + devBadge())
	}

	if m.connStatus != connOnline {
		b.WriteString("   " + hintStyle.Render("connecting..."))
	}

	if m.user != nil {
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Share your @" + sanitize(m.user.User.Username) + " to start a chat"))
	}

	b.WriteString("\n\n")

	var chatList strings.Builder

	chatList.WriteString("Chats\n\n")

	if len(m.chats) == 0 {
		chatList.WriteString("No chats.\nPress n to start one.")
	} else {
		start, end := m.chatListWindow()

		if start > 0 {
			chatList.WriteString(hintStyle.Render(fmt.Sprintf("↑ %d more", start)))
			chatList.WriteString("\n\n")
		}

		for i := start; i < end; i++ {
			chat := m.chats[i]
			cursor := "  "

			if i == m.selected {
				cursor = "▶ "
			}

			name := cursor + sanitize(chat.Username)

			if i == m.selected {
				name = selectedChatStyle.Render(name)
			}

			name = withDevBadge(name, chat.IsDeveloper)

			if chat.Pinned {
				name += hintStyle.Render("  pinned")
			}

			if chat.Muted {
				name += hintStyle.Render("  muted")
			}

			if chat.UnreadCount > 0 {
				name += " " + unreadStyle.Render(fmt.Sprintf(" %d ", chat.UnreadCount))
			}

			chatList.WriteString(name + "\n  " + m.chatPreview(chat))

			if status := m.presenceText(chat.UserID); status != "" {
				chatList.WriteString("  " + status)
			}

			if i < end-1 {
				chatList.WriteString("\n\n")
			}
		}

		if end < len(m.chats) {
			chatList.WriteString("\n\n")
			chatList.WriteString(hintStyle.Render(fmt.Sprintf("↓ %d more", len(m.chats)-end)))
		}
	}

	left := chatBoxStyle.Render(
		chatList.String(),
	)

	rightText := "Select a chat\n\n" +
		"↑ / ↓   Navigate\n" +
		"Enter   Open chat\n" +
		"n       New chat\n" +
		"r       Refresh\n" +
		"s       Settings\n" +
		"q       Quit"

	if m.creatingChat {
		rightText = "New chat\n\n" +
			"Enter the exact @username of the user:\n\n" +
			m.chatUsernameInput.View()

		if m.loading {
			rightText += "\n\nCreating chat..."
		}
	} else if m.loading {
		rightText = "Opening chat..."
	}

	right := messageBoxStyle.Render(
		rightText,
	)

	content := lipgloss.JoinHorizontal(
		lipgloss.Top,
		left,
		right,
	)

	b.WriteString(content)
	b.WriteString("\n\n")

	hint := "↑↓ / j k Navigate   Enter Open   n New chat   r Refresh   s Settings   q / Ctrl+C Quit"

	if m.creatingChat {
		hint = "Enter Create   Esc Cancel   Ctrl+C Quit"
	}

	b.WriteString(hintStyle.Render(hint))

	b.WriteString("\n")

	if m.err != nil {
		b.WriteString(
			errorStyle.Render(
				"Error: " + sanitize(m.err.Error()),
			),
		)

		b.WriteString("\n")
	}

	return b.String()
}

// chatListWindow returns the range of chats that fits on screen, keeping
// the selected chat visible.
func (m tuiModel) chatListWindow() (start, end int) {
	height := m.height

	if height == 0 {
		height = 24
	}

	// Everything except the list itself: header (4 lines), box border and
	// padding (4), "Chats" title (2), "more" markers (4), hints and error (4).
	// Each chat takes 3 lines (name, @username, blank line).
	visible := max((height-18)/3, 1)

	start = max(m.selected-visible+1, 0)
	end = min(start+visible, len(m.chats))

	return start, end
}

// chatWidths returns the width of the chat boxes (including padding) and
// of the message text inside them.
func (m tuiModel) chatWidths() (boxWidth, textWidth int) {
	boxWidth = max(m.width-4, 40)

	return boxWidth, boxWidth - 4
}

// chatFooter renders everything below the message box.
func (m tuiModel) chatFooter(boxWidth int) string {
	input := m.messageInput
	// Box padding (2), prompt "> " (2) and cursor (1).
	input.Width = max(boxWidth-5, 10)

	footer := lipgloss.NewStyle().
		Width(boxWidth).
		Border(lipgloss.RoundedBorder()).
		Padding(0, 1).
		Render(input.View())

	if bar := m.replyBar(); bar != "" {
		footer = lipgloss.NewStyle().Width(boxWidth+2).Render(bar) + "\n" + footer
	}

	hint := "Enter Send   ↑ Reply to a message   PgUp/PgDown Scroll   Home/End Jump   Ctrl+K Safety code   Esc Back   Ctrl+C Quit"

	switch {
	case m.safetyOpen && m.keyChanged[m.currentChat.UserID]:
		hint = "y The codes are the same   Esc Close"
	case m.safetyOpen:
		hint = "Esc Close"
	case m.selecting:
		hint = "↑↓ Select a message   Enter / r Reply   Esc Cancel"
	}

	footer += "\n\n" + hintStyle.Width(boxWidth+2).Render(hint)

	if m.err != nil {
		footer += "\n" + errorStyle.
			Width(boxWidth+2).
			Render("Error: "+sanitize(m.err.Error()))
	}

	return footer
}

// messageAreaHeight returns how many lines of messages fit on screen.
func (m tuiModel) messageAreaHeight() int {
	height := m.height

	if height == 0 {
		height = 24
	}

	boxWidth, _ := m.chatWidths()

	// Blank line, header, blank line, message box border and padding (4),
	// blank line, footer.
	used := 1 + 1 + 1 + 4 + 1 + lipgloss.Height(m.chatFooter(boxWidth))

	return max(height-used, 1)
}

func (m tuiModel) renderMessages(textWidth int) []string {
	rendered := make([]string, len(m.messages))

	for i, message := range m.messages {
		isOwn := m.user != nil && message.SenderID == m.user.User.ID

		name := message.SenderUsername

		if name == "" {
			if isOwn {
				name = m.user.User.Username
			} else {
				name = m.currentChat.Username
			}
		}

		style := otherMessageStyle.
			Width(textWidth).
			Align(lipgloss.Left)

		if isOwn {
			style = ownMessageStyle.
				Width(textWidth).
				Align(lipgloss.Right)
		}

		text := sanitize(name) + ": " + sanitize(m.textOf(m.currentChat, message.ID, message.SenderID, message.Content))

		if m.selecting && i == m.selectedMessage {
			text = selectedChatStyle.Render("▶ ") + text
		}

		if message.EditedAt != nil {
			text += hintStyle.Render(" (edited)")
		}

		if message.ReplyTo != nil {
			text = m.quoteLine(message.ReplyTo) + "\n" + text
		}

		if line := reactionsLine(message.Reactions); line != "" {
			text += "\n" + line
		}

		rendered[i] = style.Render(text)
	}

	return rendered
}

// messageCost is the number of lines a message takes, counting the blank
// line that separates it from the previous one.
func messageCost(rendered string, first bool) int {
	if first {
		return lipgloss.Height(rendered)
	}

	return lipgloss.Height(rendered) + 1
}

// messageWindow returns the range of messages that fits into area lines
// when the newest scroll messages are scrolled out of view.
func messageWindow(rendered []string, area, scroll int) (start, end int) {
	end = len(rendered) - min(scroll, len(rendered))
	start = end
	used := 0

	for start > 0 {
		cost := messageCost(rendered[start-1], start == end)

		// Always show at least one message, even if it is taller than area.
		if used+cost > area && start < end {
			break
		}

		used += cost
		start--
	}

	return start, end
}

// maxScroll returns the scroll value at which the oldest message is at
// the top of the message area.
func maxScroll(rendered []string, area int) int {
	used, fit := 0, 0

	for fit < len(rendered) {
		cost := messageCost(rendered[fit], fit == 0)

		if used+cost > area && fit > 0 {
			break
		}

		used += cost
		fit++
	}

	return len(rendered) - fit
}

func (m tuiModel) maxMessageScroll() int {
	_, textWidth := m.chatWidths()

	return maxScroll(m.renderMessages(textWidth), m.messageAreaHeight())
}

func (m tuiModel) chatView() string {
	boxWidth, textWidth := m.chatWidths()
	area := m.messageAreaHeight()
	rendered := m.renderMessages(textWidth)

	scroll := min(m.messageScroll, maxScroll(rendered, area))
	start, end := messageWindow(rendered, area, scroll)

	var content string

	if m.safetyOpen {
		content = m.safetyCodeView()
	} else if len(rendered) == 0 {
		content = hintStyle.Render("No messages yet.")
	} else {
		content = strings.Join(rendered[start:end], "\n\n")

		// A single message taller than the area: show its end.
		if lines := strings.Split(content, "\n"); len(lines) > area {
			content = strings.Join(lines[len(lines)-area:], "\n")
		}
	}

	messageBox := lipgloss.NewStyle().
		Width(boxWidth).
		Height(area+2).
		Border(lipgloss.RoundedBorder()).
		Padding(1, 2).
		Render(content)

	header := logoStyle.
		UnsetMarginBottom().
		Render("OSTRICH   /   " + sanitize(m.currentChat.Username))

	header = withDevBadge(header, m.currentChat.IsDeveloper)

	var status []string

	// The peer's presence is only known while we are connected ourselves.
	if m.connStatus != connOnline {
		status = append(status, hintStyle.Render("connecting..."))
	} else if m.isTyping(m.currentChat.ID) {
		status = append(status, selectedChatStyle.Render("typing…"))
	} else if peer := m.presenceText(m.currentChat.UserID); peer != "" {
		status = append(status, peer)
	}

	if m.currentChat.BlockedByMe {
		status = append(status, errorStyle.Render("blocked"))
	} else if m.currentChat.Blocked {
		status = append(status, errorStyle.Render("can't message"))
	}

	if m.keyChanged[m.currentChat.UserID] {
		status = append(status, errorStyle.Render("⚠ security key changed: Ctrl+K"))
	}

	if start > 0 {
		status = append(status, hintStyle.Render(fmt.Sprintf("↑ %d older", start)))
	}

	if end < len(rendered) {
		status = append(status, hintStyle.Render(fmt.Sprintf("↓ %d newer", len(rendered)-end)))
	}

	if len(status) > 0 {
		header += "   " + strings.Join(status, "   ")
	}

	return "\n" + header + "\n\n" + messageBox + "\n\n" + m.chatFooter(boxWidth)
}
