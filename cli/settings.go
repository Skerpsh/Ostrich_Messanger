package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

// Settings, with the same sections as the web: profile, appearance,
// account, privacy, notifications, devices, security, danger zone.

const maxAvatarBytes = 8 << 20

type settingsState struct {
	// The selected row (index into settingsRows) and the first line shown.
	cursor, scroll int

	// The open form ("username", "password", "photo", "delete") and its
	// inputs.
	form      string
	inputs    []textinput.Model
	formFocus int
	formErr   string
	formOK    string
	busy      bool
	// Deleting the account takes a second Enter.
	confirmDelete bool

	sessions       []Session
	sessionsLoaded bool
	sessionsErr    string

	// A row waiting for its second Enter (log out a device / everywhere).
	confirming string
}

func (s *settingsState) restyle(p palette) {
	for i := range s.inputs {
		styleInput(&s.inputs[i], p)
	}
}

func (s *settingsState) resize(w int) {
	for i := range s.inputs {
		s.inputs[i].Width = max(settingsContentWidth(w)-6, 10)
	}
}

func settingsContentWidth(paneWidth int) int {
	return min(paneWidth-4, 68)
}

func (m *model) openSettings() tea.Cmd {
	m.settings = &settingsState{}
	m.menu = nil
	m.safetyOpen = false
	m.focus = paneSettings

	if m.chat != nil {
		m.chat.composer.Blur()
	}

	if m.list.searching {
		m.stopSearch()
	}

	m.selectFirstSettingsRow()

	return m.loadSessions()
}

func (m *model) closeSettings() tea.Cmd {
	m.settings = nil

	if m.chat != nil {
		m.focus = paneChat
		return m.chat.composer.Focus()
	}

	m.focus = paneList

	return nil
}

func (m *model) loadSessions() tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		sessions, err := getSessions(token)

		return func(m *model) tea.Cmd {
			if m.settings == nil {
				return nil
			}

			if err != nil {
				m.settings.sessionsErr = err.Error()
				return m.failSilently(err)
			}

			m.settings.sessions = sessions
			m.settings.sessionsLoaded = true
			m.settings.sessionsErr = ""

			return nil
		}
	})
}

// failSilently logs out on an expired session; other errors are shown
// where they happened.
func (m *model) failSilently(err error) tea.Cmd {
	if err == errSessionExpired {
		return m.signOut(err.Error())
	}

	return nil
}

// --- rows ---

const (
	rowSection = iota
	rowProfile
	rowAction
	rowToggle
	rowThemes
	rowAccents
)

type settingsRow struct {
	kind   int
	id     string
	icon   string
	label  string
	value  string
	hint   string
	danger bool
	on     bool
	// The form shown under the row while open.
	form   string
	action func(*model) tea.Cmd
}

func (r settingsRow) selectable() bool {
	return r.kind != rowSection && r.kind != rowProfile
}

var clientNames = map[string]string{
	"web":     "Web browser",
	"ios":     "iPhone / iPad",
	"android": "Android",
	"macos":   "Mac",
	"windows": "Windows",
	"cli":     "Terminal (CLI)",
}

func (m model) settingsRows() []settingsRow {
	s := m.settings
	u := m.user.User
	section := func(title string) settingsRow { return settingsRow{kind: rowSection, label: title} }

	rows := []settingsRow{
		{kind: rowProfile},
		{kind: rowAction, id: "copy", icon: "⧉", label: "Copy username", action: func(m *model) tea.Cmd {
			if err := copyText("@" + m.user.User.Username); err != nil {
				return m.showToast(err.Error(), true)
			}

			return m.showToast("Copied @"+m.user.User.Username, false)
		}},
		{kind: rowAction, id: "qr", icon: "▦", label: "My QR code", action: func(m *model) tea.Cmd {
			m.qr = &qrState{title: "@" + m.user.User.Username + ": scanned, it opens a chat with you", text: profileLink(m.user.User.Username)}
			return nil
		}},
		{kind: rowAction, id: "photo", icon: "▣", label: "Set photo from a file", form: "photo"},
	}

	if u.AvatarID != nil {
		rows = append(rows, settingsRow{kind: rowAction, id: "removephoto", icon: "✕", label: "Remove photo", action: (*model).removePhoto})
	}

	rows = append(rows,
		section("Appearance"),
		settingsRow{kind: rowThemes, id: "theme", icon: "◐", label: "Theme"},
		settingsRow{kind: rowAccents, id: "accent", icon: "●", label: "Accent color", value: findAccent(m.cfg.Accent).name},

		section("Account"),
		settingsRow{kind: rowAction, id: "username", icon: "@", label: "Username", value: "@" + sanitize(u.Username), form: "username"},
		settingsRow{kind: rowAction, id: "password", icon: "⚿", label: "Password", form: "password"},

		section("Privacy"),
		settingsRow{kind: rowToggle, id: "presence", icon: "◉", label: "Show when I'm online", on: u.ShowPresence,
			hint: "Off: nobody sees your online status or when you were last seen.",
			action: func(m *model) tea.Cmd {
				value := !m.user.User.ShowPresence
				return m.setPrivacy(&value, nil)
			}},
		settingsRow{kind: rowToggle, id: "receipts", icon: "✓", label: "Read receipts", on: u.ReadReceipts,
			hint: "Off: others don't see when you've read their messages, and you don't see theirs.",
			action: func(m *model) tea.Cmd {
				value := !m.user.User.ReadReceipts
				return m.setPrivacy(nil, &value)
			}},

		section("Notifications"),
		settingsRow{kind: rowToggle, id: "bell", icon: "♪", label: "Bell for new messages", on: m.cfg.Bell,
			hint: "The terminal bell rings for messages in other chats. Muted chats stay quiet.",
			action: func(m *model) tea.Cmd {
				m.cfg.Bell = !m.cfg.Bell
				m.cfg.save()
				return nil
			}},

		section("Devices"),
	)

	switch {
	case s.sessionsErr != "":
		rows = append(rows, settingsRow{kind: rowAction, id: "sessions-retry", icon: "↻", label: "Couldn't load the devices: retry", danger: true,
			action: (*model).loadSessions})
	case !s.sessionsLoaded:
		rows = append(rows, settingsRow{kind: rowAction, id: "sessions-loading", icon: "…", label: "Loading devices…"})
	}

	for _, session := range s.sessions {
		session := session
		name := "Unknown app"

		if session.Client != nil {
			if known, ok := clientNames[*session.Client]; ok {
				name = known
			}
		}

		value := "Active " + formatChatDate(session.LastUsedAt) + " · since " + formatDate(session.CreatedAt)
		row := settingsRow{kind: rowAction, id: "session:" + session.ID, icon: "▭", label: name, value: value}

		if session.Current {
			row.value = "This device"
		} else {
			row.action = func(m *model) tea.Cmd { return m.endSession(session) }
			row.hint = "Enter logs this device out"
		}

		rows = append(rows, row)
	}

	rows = append(rows,
		section("Security"),
		settingsRow{kind: rowAction, id: "logoutall", icon: "⏻", label: "Log out of all devices", danger: true,
			hint:   "If you think someone else has access to your account. You will need your username, password and OstrichID to log in again.",
			action: (*model).logoutEverywhere},
		settingsRow{kind: rowAction, id: "logout", icon: "⇥", label: "Log out", action: func(m *model) tea.Cmd {
			token := m.user.Token

			return tea.Batch(m.signOut(""), func() tea.Msg {
				_ = logout(token)
				return nil
			})
		}},

		section("Danger zone"),
		settingsRow{kind: rowAction, id: "delete", icon: "🗑", label: "Delete account", danger: true, form: "delete"},
	)

	return rows
}

func (m *model) selectFirstSettingsRow() {
	for i, r := range m.settingsRows() {
		if r.selectable() {
			m.settings.cursor = i
			return
		}
	}
}

func (m *model) moveSettingsCursor(delta int) {
	rows := m.settingsRows()
	s := m.settings

	for i := s.cursor + delta; i >= 0 && i < len(rows); i += delta {
		if rows[i].selectable() {
			s.cursor = i
			s.confirming = ""
			return
		}
	}
}

// --- forms ---

func (m *model) openForm(form string) tea.Cmd {
	s := m.settings
	p := m.pal

	if s.form == form {
		s.form = ""
		return nil
	}

	s.form = form
	s.formErr = ""
	s.formOK = ""
	s.formFocus = 0
	s.confirmDelete = false

	switch form {
	case "username":
		s.inputs = []textinput.Model{
			newInput("@new_username", 33, false, p),
			newInput("Password", 128, true, p),
		}
	case "password":
		s.inputs = []textinput.Model{
			newInput("Current password", 128, true, p),
			newInput("New password", 128, true, p),
			newInput("Repeat the new password", 128, true, p),
		}
	case "photo":
		s.inputs = []textinput.Model{newInput("Path to a JPEG, PNG or WebP image", 1024, false, p)}
	case "delete":
		s.inputs = []textinput.Model{
			newInput("Password", 128, true, p),
			newInput("OstrichID", 40, true, p),
		}
	}

	s.resize(m.paneWidth())

	return s.inputs[0].Focus()
}

func (m *model) focusFormField(i int) tea.Cmd {
	s := m.settings
	s.formFocus = (i%len(s.inputs) + len(s.inputs)) % len(s.inputs)

	for j := range s.inputs {
		s.inputs[j].Blur()
	}

	return s.inputs[s.formFocus].Focus()
}

func (m *model) updateFormKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings

	switch msg.String() {
	case "esc":
		s.form = ""
		return nil
	case "tab", "down":
		return m.focusFormField(s.formFocus + 1)
	case "shift+tab", "up":
		return m.focusFormField(s.formFocus - 1)
	case "enter":
		if s.formFocus < len(s.inputs)-1 {
			return m.focusFormField(s.formFocus + 1)
		}

		return m.submitForm()
	}

	var cmd tea.Cmd
	s.inputs[s.formFocus], cmd = s.inputs[s.formFocus].Update(msg)
	s.formErr = ""

	return cmd
}

func (m *model) submitForm() tea.Cmd {
	s := m.settings

	if s.busy {
		return nil
	}

	value := func(i int) string { return s.inputs[i].Value() }
	token := m.user.Token
	s.formErr = ""
	s.formOK = ""

	// run does the request; done applies its result.
	run := func(work func() error, done func(m *model) tea.Cmd) tea.Cmd {
		s.busy = true

		return task(func() func(*model) tea.Cmd {
			err := work()

			return func(m *model) tea.Cmd {
				if m.settings == nil {
					return nil
				}

				m.settings.busy = false

				if err != nil {
					m.settings.formErr = err.Error()
					m.settings.confirmDelete = false

					return m.failSilently(err)
				}

				return done(m)
			}
		})
	}

	switch s.form {
	case "username":
		name := cleanUsername(value(0))
		password := value(1)

		switch {
		case !validUsername(name):
			s.formErr = errInvalidUsername.Error()
			return nil
		case password == "":
			s.formErr = "Password is required"
			return nil
		}

		var account *Account

		return run(func() (err error) {
			account, err = changeUsername(token, name, password)
			return err
		}, func(m *model) tea.Cmd {
			m.user.User = *account
			m.settings.form = ""

			return tea.Batch(m.showToast("Username changed. Use the new one to log in.", false), func() tea.Msg {
				updateSavedUser(*account)
				return nil
			})
		})

	case "password":
		current, next, repeat := value(0), value(1), value(2)

		switch {
		case current == "":
			s.formErr = "Current password is required"
			return nil
		case len([]rune(next)) < minPasswordLength:
			s.formErr = fmt.Sprintf("The new password needs at least %d characters", minPasswordLength)
			return nil
		case next != repeat:
			s.formErr = "The new passwords do not match"
			return nil
		}

		return run(func() error {
			return changePassword(token, current, next)
		}, func(m *model) tea.Cmd {
			m.settings.form = ""

			return m.showToast("Password changed. Other devices have been logged out.", false)
		})

	case "photo":
		path := strings.TrimSpace(value(0))

		if strings.HasPrefix(path, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				path = filepath.Join(home, path[2:])
			}
		}

		var account *Account

		return run(func() error {
			info, err := os.Stat(path)

			switch {
			case err != nil:
				return fmt.Errorf("can't open the file: %w", err)
			case info.Size() > maxAvatarBytes:
				return fmt.Errorf("the image is larger than 8 MB")
			}

			image, err := os.ReadFile(path)
			if err != nil {
				return err
			}

			account, err = uploadAvatar(token, image)

			return err
		}, func(m *model) tea.Cmd {
			m.user.User = *account
			m.settings.form = ""

			return m.showToast("Photo set", false)
		})

	case "delete":
		password, id := value(0), value(1)

		switch {
		case password == "" || normalizeOstrichID(id) == "":
			s.formErr = "Enter your password and OstrichID"
			return nil
		case !s.confirmDelete:
			s.confirmDelete = true
			return nil
		}

		return run(func() error {
			return deleteAccount(token, password, id)
		}, func(m *model) tea.Cmd {
			return m.signOut("Your account has been deleted")
		})
	}

	return nil
}

// --- actions ---

func (m *model) setPrivacy(showPresence, readReceipts *bool) tea.Cmd {
	token := m.user.Token
	previous := m.user.User

	// Shown right away; undone if it fails.
	if showPresence != nil {
		m.user.User.ShowPresence = *showPresence
	}

	if readReceipts != nil {
		m.user.User.ReadReceipts = *readReceipts
	}

	return task(func() func(*model) tea.Cmd {
		account, err := setPrivacy(token, showPresence, readReceipts)

		return func(m *model) tea.Cmd {
			if m.user == nil || m.user.Token != token {
				return nil
			}

			if err != nil {
				m.user.User = previous
				return m.fail(err)
			}

			m.user.User = *account

			return nil
		}
	})
}

func (m *model) removePhoto() tea.Cmd {
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		account, err := removeAvatar(token)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if m.user != nil {
				m.user.User = *account
			}

			return m.showToast("Photo removed", false)
		}
	})
}

func (m *model) endSession(session Session) tea.Cmd {
	s := m.settings
	id := "session:" + session.ID

	if s.confirming != id {
		s.confirming = id
		return nil
	}

	s.confirming = ""
	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		err := endSession(token, session.ID)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			if m.settings == nil {
				return nil
			}

			return tea.Batch(m.showToast("The device has been logged out", false), m.loadSessions())
		}
	})
}

func (m *model) logoutEverywhere() tea.Cmd {
	s := m.settings

	if s.confirming != "logoutall" {
		s.confirming = "logoutall"
		return nil
	}

	token := m.user.Token

	return task(func() func(*model) tea.Cmd {
		err := logoutAll(token)

		return func(m *model) tea.Cmd {
			if err != nil {
				return m.fail(err)
			}

			return m.signOut("Logged out of all devices")
		}
	})
}

func (m *model) setThemePreference(theme string) {
	m.cfg.Theme = theme
	m.cfg.save()
	m.applyTheme()
}

func (m *model) shiftAccent(delta int) {
	i := 0

	for j, a := range accents {
		if a.id == m.cfg.Accent {
			i = j
		}
	}

	i = (i + delta + len(accents)) % len(accents)
	m.cfg.Accent = accents[i].id
	m.cfg.save()
	m.applyTheme()
}

var themeOptions = []struct{ id, label string }{
	{"system", "System"},
	{"light", "Light"},
	{"dark", "Dark"},
}

func (m *model) shiftTheme(delta int) {
	i := 0

	for j, option := range themeOptions {
		if option.id == m.cfg.Theme {
			i = j
		}
	}

	i = min(max(i+delta, 0), len(themeOptions)-1)
	m.setThemePreference(themeOptions[i].id)
}

// activateSettingsRow runs the selected row.
func (m *model) activateSettingsRow() tea.Cmd {
	rows := m.settingsRows()
	s := m.settings

	if s.cursor >= len(rows) {
		return nil
	}

	r := rows[s.cursor]

	switch {
	case r.form != "":
		return m.openForm(r.form)
	case r.kind == rowThemes:
		m.shiftTheme(1)
	case r.kind == rowAccents:
		m.shiftAccent(1)
	case r.action != nil:
		return r.action(m)
	}

	return nil
}

func (m *model) updateSettingsKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings

	if s.form != "" && len(s.inputs) > 0 {
		cmd := m.updateFormKey(msg)
		m.scrollSettings()

		return cmd
	}

	rows := m.settingsRows()
	defer m.scrollSettings()

	switch msg.String() {
	case "esc", "q":
		return m.closeSettings()
	case "up", "k":
		m.moveSettingsCursor(-1)
	case "down", "j":
		m.moveSettingsCursor(1)
	case "left", "h":
		switch rows[s.cursor].kind {
		case rowThemes:
			m.shiftTheme(-1)
		case rowAccents:
			m.shiftAccent(-1)
		}
	case "right", "l":
		switch rows[s.cursor].kind {
		case rowThemes:
			m.shiftTheme(1)
		case rowAccents:
			m.shiftAccent(1)
		}
	case "enter", " ":
		return m.activateSettingsRow()
	case "tab":
		if m.wide() {
			m.focus = paneList
		}
	}

	return nil
}

func (m *model) updateSettingsMouse(msg tea.MouseMsg) tea.Cmd {
	s := m.settings

	if d := wheel(msg, "set:body"); d != 0 {
		s.scroll = max(s.scroll+d*wheelLines, 0)
		return nil
	}

	if clicked(msg, "set:close") {
		return m.closeSettings()
	}

	for _, option := range themeOptions {
		if clicked(msg, "set:theme:"+option.id) {
			m.focus = paneSettings
			m.setThemePreference(option.id)

			return nil
		}
	}

	for i, a := range accents {
		if clicked(msg, fmt.Sprintf("set:accent:%d", i)) {
			m.focus = paneSettings
			m.cfg.Accent = a.id
			m.cfg.save()
			m.applyTheme()

			return nil
		}
	}

	for i := range s.inputs {
		if s.form != "" && clicked(msg, fmt.Sprintf("set:field:%d", i)) {
			m.focus = paneSettings
			return m.focusFormField(i)
		}
	}

	if s.form != "" && clicked(msg, "set:submit") {
		return m.submitForm()
	}

	for i, r := range m.settingsRows() {
		if r.selectable() && clicked(msg, fmt.Sprintf("set:row:%d", i)) {
			m.focus = paneSettings

			if s.cursor != i {
				s.confirming = ""
			}

			s.cursor = i

			return m.activateSettingsRow()
		}
	}

	return nil
}

// --- view ---

// settingsBody draws everything below the header; rowAt[i] is the first
// line of row i.
func (m model) settingsBody(w int) (lines []string, rowAt []int) {
	s := m.settings
	p := m.pal
	bg := p.bg
	cw := settingsContentWidth(w)
	left := max((w-cw)/2, 0)
	card := p.panel

	// put adds a line (or a block of lines) of the content column.
	put := func(block string) {
		for _, line := range strings.Split(block, "\n") {
			lines = append(lines, blank(left, bg)+line+blank(w-left-cw, bg))
		}
	}

	rows := m.settingsRows()
	rowAt = make([]int, len(rows))
	u := m.user.User

	for i, r := range rows {
		rowAt[i] = len(lines)
		selected := i == s.cursor && m.focus == paneSettings
		rowBg := card

		if selected {
			rowBg = p.hover
		}

		switch r.kind {
		case rowSection:
			put(blank(cw, bg))
			put(fitLine(bold(" "+strings.ToUpper(r.label), p.muted, bg), cw, bg))

		case rowProfile:
			name := bold("@"+sanitize(u.Username), p.text, card)

			if u.IsDeveloper {
				name += blank(1, card) + devBadge()
			}

			photo := "no photo"

			if u.AvatarID != nil {
				photo = "photo set (shown in the apps)"
			}

			put(blank(cw, card))
			put(center(avatar(u.Username), cw, card))
			put(center(name, cw, card))
			put(center(seg(photo, p.muted, card), cw, card))
			put(center(seg("Friends start chats with you by your username.", p.muted, card), cw, card))
			put(blank(cw, card))

		case rowThemes:
			var options []string

			for _, option := range themeOptions {
				fg, optionBg := p.muted, p.panelAlt

				if m.cfg.Theme == option.id {
					fg, optionBg = p.accent, p.accentSoft
				}

				options = append(options, zone.Mark("set:theme:"+option.id, bold(" "+option.label+" ", fg, optionBg)))
			}

			label := seg(" "+r.icon+"  ", p.muted, rowBg) + seg(r.label, p.text, rowBg)
			put(zone.Mark(fmt.Sprintf("set:row:%d", i), row(label, strings.Join(options, blank(1, rowBg))+blank(1, rowBg), cw, rowBg)))

		case rowAccents:
			var swatches []string

			for j, a := range accents {
				variant := a.dark

				if p.mode == themeLight {
					variant = a.light
				}

				mark := " ● "

				if a.id == m.cfg.Accent {
					mark = "[●]"
				}

				swatches = append(swatches, zone.Mark(fmt.Sprintf("set:accent:%d", j), seg(mark, lipgloss.Color(variant.accent), rowBg)))
			}

			label := seg(" "+r.icon+"  ", p.accent, rowBg) + seg(r.label, p.text, rowBg)
			put(zone.Mark(fmt.Sprintf("set:row:%d", i), row(label, strings.Join(swatches, "")+blank(1, rowBg), cw, rowBg)))

		default:
			fg := p.text

			if r.danger {
				fg = p.danger
			}

			label := r.label

			if s.confirming == r.id {
				switch {
				case r.id == "logoutall":
					label = "Press Enter again to log out on all devices"
				case strings.HasPrefix(r.id, "session:"):
					label = "Press Enter again to log this device out"
				}
			}

			right := ""

			switch {
			case r.kind == rowToggle:
				right = toggleView(r.on, p, rowBg)
			case r.value != "":
				right = seg(clip(r.value, cw/2), p.muted, rowBg) + blank(1, rowBg)
			case r.form != "":
				arrow := "▾"

				if s.form == r.form {
					arrow = "▴"
				}

				right = seg(arrow+" ", p.muted, rowBg)
			}

			if r.form != "" && r.value != "" {
				arrow := " ▾ "

				if s.form == r.form {
					arrow = " ▴ "
				}

				right = seg(clip(r.value, cw/2), p.muted, rowBg) + seg(arrow, p.muted, rowBg)
			}

			iconColor := p.muted

			if r.danger {
				iconColor = p.danger
			}

			line := row(seg(" "+r.icon+"  ", iconColor, rowBg)+bold(label, fg, rowBg), right, cw, rowBg)
			block := []string{line}

			if r.hint != "" && (r.kind == rowToggle || selected) {
				for _, hint := range wrap(r.hint, cw-6) {
					block = append(block, blank(4, rowBg)+fitLine(seg(hint, p.muted, rowBg), cw-4, rowBg))
				}
			}

			put(zone.Mark(fmt.Sprintf("set:row:%d", i), strings.Join(block, "\n")))

			if r.form != "" && s.form == r.form {
				for _, line := range m.formLines(cw) {
					put(line)
				}
			}
		}
	}

	put(blank(cw, bg))

	return lines, rowAt
}

// toggleView draws a switch: "━●" on, "●━" off.
func toggleView(on bool, p palette, bg lipgloss.Color) string {
	if on {
		return seg("━━", p.accent, bg) + seg("●", p.accent, bg) + blank(1, bg)
	}

	return seg("●", p.muted, bg) + seg("━━", p.panelAlt, bg) + blank(1, bg)
}

// formLines draws the open form.
func (m model) formLines(cw int) []string {
	s := m.settings
	p := m.pal
	bg := p.panel
	inner := cw - 4
	var lines []string

	add := func(line string) {
		lines = append(lines, blank(2, bg)+fitLine(line, inner, bg)+blank(2, bg))
	}

	intro := map[string]string{
		"username": "You log in with your username, and others find you by it. It can be changed once every 28 days.",
		"password": "Your other devices will be logged out.",
		"photo":    "Shown to your contacts in the apps. Re-encoded as a square picture without metadata.",
		"delete":   "Deletes your account, all your chats (for the people you talk to as well) and your messages. This cannot be undone.",
	}

	add("")

	if s.form == "username" && m.user.User.NextUsernameChangeAt != nil {
		for _, line := range wrap("You can change it again on "+formatDate(*m.user.User.NextUsernameChangeAt)+".", inner) {
			add(seg(line, p.muted, bg))
		}

		add("")

		return lines
	}

	for _, line := range wrap(intro[s.form], inner) {
		add(seg(line, p.textSoft, bg))
	}

	add("")

	for i := range s.inputs {
		add(zone.Mark(fmt.Sprintf("set:field:%d", i), m.inputBox(s.inputs[i].View(), s.formFocus == i, inner)))
	}

	if s.formErr != "" {
		add("")

		for _, line := range wrap(sanitize(s.formErr), inner) {
			add(seg(line, p.danger, bg))
		}
	}

	label := map[string]string{
		"username": "Change username",
		"password": "Change password",
		"photo":    "Set photo",
		"delete":   "Delete account",
	}[s.form]

	if s.form == "delete" && s.confirmDelete {
		label = "Delete forever? Press Enter again"
	}

	if s.busy {
		label = "…"
	}

	add("")
	add(zone.Mark("set:submit", m.button(label, inner, s.form != "delete", true)))

	if s.form == "delete" {
		lines[len(lines)-1] = blank(2, bg) + zone.Mark("set:submit", center(bold(label, p.onAccent, p.danger), inner, p.danger)) + blank(2, bg)
	}

	add("")

	return lines
}

// scrollSettings keeps the selected row (and an open form) on screen.
func (m *model) scrollSettings() {
	s := m.settings

	if s == nil {
		return
	}

	lines, rowAt := m.settingsBody(m.paneWidth())
	area := m.height - 3

	if s.cursor >= len(rowAt) {
		return
	}

	top := rowAt[s.cursor]
	bottom := len(lines)

	if s.cursor+1 < len(rowAt) {
		bottom = rowAt[s.cursor+1]
	}

	if bottom-s.scroll > area {
		s.scroll = bottom - area
	}

	if top < s.scroll {
		s.scroll = top
	}

	s.scroll = min(max(s.scroll, 0), max(len(lines)-area, 0))
}

func (m model) settingsView(w, h int) string {
	p := m.pal
	bg := p.surface

	closeIcon := " ✕ "

	if !m.wide() {
		closeIcon = " ‹ "
	}

	header := []string{
		row(blank(1, bg)+bold("Settings", p.text, bg), zone.Mark("set:close", seg(closeIcon, p.accent, bg)), w, bg),
		seg(strings.Repeat("─", w), p.line, bg),
	}

	lines, _ := m.settingsBody(w)
	area := h - 3
	scroll := min(m.settings.scroll, max(len(lines)-area, 0))
	end := min(scroll+area, len(lines))
	body := zone.Mark("set:body", fitBlock(strings.Join(lines[scroll:end], "\n"), w, area, p.bg))

	hints := "↑↓ Move  Enter Select  ←→ Change  Esc Close"

	if m.settings.form != "" {
		hints = "↑↓/Tab Field  Enter Next / Submit  Esc Cancel"
	}

	return strings.Join(append(header, body, m.hintLine(hints, w, bg)), "\n")
}
