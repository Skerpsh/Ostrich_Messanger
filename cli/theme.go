package main

import (
	"fmt"
	"strconv"

	"github.com/charmbracelet/lipgloss"
)

// Colors of the app's themes, the same as the web's
// (frontend/src/theme/colors.ts). Semi-transparent web colors are blended
// into solid ones, since terminals have no transparency.

type themeMode int

const (
	themeDark themeMode = iota
	themeLight
)

type palette struct {
	mode themeMode

	// Page behind everything (the chat), side bar and bars, cards and
	// other people's bubbles, inputs.
	bg, surface, panel, panelAlt lipgloss.Color

	// Selected or hovered rows.
	hover lipgloss.Color

	text, textSoft, muted lipgloss.Color

	// Dividers and borders.
	line lipgloss.Color

	accent, onAccent lipgloss.Color

	// A faint accent over the side bar / page: selected chat, chips.
	accentSoft, accentSoftBg lipgloss.Color

	danger, online lipgloss.Color
}

type basePalette struct {
	bg, surface, panel, panelAlt, hover, text, textSoft, muted, danger, online string

	// "rgba(r, g, b, lineAlpha)" over the background.
	lineRGB   string
	lineAlpha float64

	// Opacity of accentSoft.
	softAlpha float64
}

var basePalettes = map[themeMode]basePalette{
	themeDark: {
		bg:        "#0f0f10",
		surface:   "#151517",
		panel:     "#1c1c1f",
		panelAlt:  "#26262a",
		hover:     "#202024",
		text:      "#f5f5f5",
		textSoft:  "#cfcfd4",
		muted:     "#8e8e93",
		danger:    "#ff6b6b",
		online:    "#4cd964",
		lineRGB:   "#ffffff",
		lineAlpha: 0.12,
		softAlpha: 0.16,
	},
	themeLight: {
		bg:        "#f4f4f5",
		surface:   "#ffffff",
		panel:     "#ffffff",
		panelAlt:  "#ececee",
		hover:     "#f0f0f2",
		text:      "#111113",
		textSoft:  "#3a3a3f",
		muted:     "#6e6e73",
		danger:    "#c62828",
		online:    "#2e7d32",
		lineRGB:   "#000000",
		lineAlpha: 0.12,
		softAlpha: 0.12,
	},
}

type accentVariant struct{ accent, onAccent string }

type accent struct {
	id, name    string
	dark, light accentVariant
}

// The accent colors of Settings → Appearance, as on the web.
var accents = []accent{
	{"orange", "Orange", accentVariant{"#ff8a3d", "#1a0e04"}, accentVariant{"#b84e08", "#ffffff"}},
	{"red", "Red", accentVariant{"#ff7070", "#2a0505"}, accentVariant{"#c0262d", "#ffffff"}},
	{"pink", "Pink", accentVariant{"#ff7ab6", "#2b0418"}, accentVariant{"#b3206a", "#ffffff"}},
	{"purple", "Purple", accentVariant{"#b392ff", "#170838"}, accentVariant{"#6a3cd0", "#ffffff"}},
	{"blue", "Blue", accentVariant{"#5aa9ff", "#04162b"}, accentVariant{"#1c5fc4", "#ffffff"}},
	{"teal", "Teal", accentVariant{"#3ed6c5", "#03211d"}, accentVariant{"#0a756a", "#ffffff"}},
	{"green", "Green", accentVariant{"#6fdc6f", "#062006"}, accentVariant{"#2b7a30", "#ffffff"}},
	{"gold", "Gold", accentVariant{"#f5c542", "#2a2000"}, accentVariant{"#856400", "#ffffff"}},
	{"mono", "Mono", accentVariant{"#f5f5f5", "#111113"}, accentVariant{"#111113", "#ffffff"}},
}

const defaultAccent = "orange"

func findAccent(id string) accent {
	for _, a := range accents {
		if a.id == id {
			return a
		}
	}

	return accents[0]
}

func newPalette(mode themeMode, accentID string) palette {
	base := basePalettes[mode]
	variant := findAccent(accentID).dark

	if mode == themeLight {
		variant = findAccent(accentID).light
	}

	return palette{
		mode:         mode,
		bg:           lipgloss.Color(base.bg),
		surface:      lipgloss.Color(base.surface),
		panel:        lipgloss.Color(base.panel),
		panelAlt:     lipgloss.Color(base.panelAlt),
		hover:        lipgloss.Color(base.hover),
		text:         lipgloss.Color(base.text),
		textSoft:     lipgloss.Color(base.textSoft),
		muted:        lipgloss.Color(base.muted),
		line:         lipgloss.Color(blend(base.lineRGB, base.surface, base.lineAlpha)),
		accent:       lipgloss.Color(variant.accent),
		onAccent:     lipgloss.Color(variant.onAccent),
		accentSoft:   lipgloss.Color(blend(variant.accent, base.surface, base.softAlpha)),
		accentSoftBg: lipgloss.Color(blend(variant.accent, base.bg, base.softAlpha)),
		danger:       lipgloss.Color(base.danger),
		online:       lipgloss.Color(base.online),
	}
}

// blend returns the color of `top` drawn with opacity alpha over `under`
// (both "#rrggbb").
func blend(top, under string, alpha float64) string {
	t, u := hexRGB(top), hexRGB(under)
	var out [3]int

	for i := range out {
		out[i] = int(float64(t[i])*alpha + float64(u[i])*(1-alpha) + 0.5)
	}

	return fmt.Sprintf("#%02x%02x%02x", out[0], out[1], out[2])
}

func hexRGB(hex string) [3]int {
	n, _ := strconv.ParseUint(hex[1:], 16, 32)

	return [3]int{int(n >> 16 & 255), int(n >> 8 & 255), int(n & 255)}
}

// Avatar colors: initials on a color picked from the username, so a
// contact keeps their color.
var avatarColors = []string{
	"#e57373", "#f06292", "#ba68c8", "#7986cb", "#4fc3f7",
	"#4db6ac", "#81c784", "#ffb74d", "#a1887f", "#90a4ae",
}

func avatarColor(username string) lipgloss.Color {
	h := 0

	for _, r := range username {
		h = h*31 + int(r)
	}

	if h < 0 {
		h = -h
	}

	return lipgloss.Color(avatarColors[h%len(avatarColors)])
}
