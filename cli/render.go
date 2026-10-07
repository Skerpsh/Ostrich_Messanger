package main

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Drawing helpers. Every piece of text is drawn with an explicit
// background: a reset inside a line would otherwise show the terminal's
// own background through the theme.

// seg draws text in fg on bg.
func seg(text string, fg, bg lipgloss.Color) string {
	return lipgloss.NewStyle().Foreground(fg).Background(bg).Render(text)
}

// bold draws bold text in fg on bg.
func bold(text string, fg, bg lipgloss.Color) string {
	return lipgloss.NewStyle().Bold(true).Foreground(fg).Background(bg).Render(text)
}

// italic draws italic text in fg on bg.
func italic(text string, fg, bg lipgloss.Color) string {
	return lipgloss.NewStyle().Italic(true).Foreground(fg).Background(bg).Render(text)
}

// blank is n spaces on bg.
func blank(n int, bg lipgloss.Color) string {
	if n <= 0 {
		return ""
	}

	return lipgloss.NewStyle().Background(bg).Render(strings.Repeat(" ", n))
}

// width is the number of cells a (styled) string takes.
func width(s string) int {
	return ansi.StringWidth(s)
}

// fitLine pads a line with bg to exactly w cells, or cuts it.
func fitLine(line string, w int, bg lipgloss.Color) string {
	n := width(line)

	if n > w {
		return ansi.Truncate(line, w, "")
	}

	return line + blank(w-n, bg)
}

// fitBlock makes a block exactly w × h cells: lines padded or cut,
// missing lines added on bg.
func fitBlock(block string, w, h int, bg lipgloss.Color) string {
	lines := strings.Split(block, "\n")

	if block == "" {
		lines = nil
	}

	if len(lines) > h {
		lines = lines[:h]
	}

	for len(lines) < h {
		lines = append(lines, "")
	}

	for i, line := range lines {
		lines[i] = fitLine(line, w, bg)
	}

	return strings.Join(lines, "\n")
}

// row puts left and right parts on one line of w cells, the gap on bg.
// The left part is shortened if both do not fit.
func row(left, right string, w int, bg lipgloss.Color) string {
	gap := w - width(left) - width(right)

	if gap < 1 {
		left = ansi.Truncate(left, max(w-width(right)-1, 0), "…")
		gap = w - width(left) - width(right)
	}

	return left + blank(gap, bg) + right
}

// center puts s in the middle of a line of w cells.
func center(s string, w int, bg lipgloss.Color) string {
	n := width(s)

	if n >= w {
		return ansi.Truncate(s, w, "")
	}

	left := (w - n) / 2

	return blank(left, bg) + s + blank(w-n-left, bg)
}

// alignRight puts s at the right end of a line of w cells.
func alignRight(s string, w int, bg lipgloss.Color) string {
	return blank(w-width(s), bg) + s
}

// clip shortens plain text to w cells with an ellipsis.
func clip(text string, w int) string {
	if w <= 0 {
		return ""
	}

	return ansi.Truncate(text, w, "…")
}

// wrap breaks plain text into lines of at most w cells, at spaces where
// possible.
func wrap(text string, w int) []string {
	if w < 1 {
		w = 1
	}

	var lines []string

	for _, paragraph := range strings.Split(text, "\n") {
		if paragraph == "" {
			lines = append(lines, "")
			continue
		}

		lines = append(lines, strings.Split(ansi.Wrap(paragraph, w, ""), "\n")...)
	}

	return lines
}

// oneLine joins whitespace, for previews.
func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// hjoin puts blocks of the same height side by side.
func hjoin(blocks ...string) string {
	return lipgloss.JoinHorizontal(lipgloss.Top, blocks...)
}

// overlay draws box over the middle of base (w × h cells).
func overlay(base, box string, w, h int) string {
	baseLines := strings.Split(base, "\n")
	boxLines := strings.Split(box, "\n")
	boxW := 0

	for _, line := range boxLines {
		boxW = max(boxW, width(line))
	}

	x := max((w-boxW)/2, 0)
	y := max((h-len(boxLines))/2, 0)

	for i, line := range boxLines {
		at := y + i

		if at >= len(baseLines) {
			break
		}

		under := baseLines[at]
		left := ansi.Truncate(under, x, "")
		right := ansi.TruncateLeft(under, x+boxW, "")
		baseLines[at] = left + "\x1b[0m" + line + "\x1b[0m" + right
	}

	return strings.Join(baseLines, "\n")
}

// sanitize removes terminal control characters (escape sequences, bidi
// controls) from server-provided text, including error messages, so that
// other users or a malicious server cannot mess with the terminal.
// Newlines are kept, tabs become spaces.
func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r == '\t':
			return ' '
		case unicode.IsControl(r),
			r >= '‪' && r <= '‮',
			r >= '⁦' && r <= '⁩',
			r == '‎', r == '‏', r == '؜':
			return -1
		}

		return r
	}, s)
}

// initial is the first letter of a name, for avatars.
func initial(name string) string {
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return strings.ToUpper(string(r))
		}
	}

	return "?"
}

// onBackground keeps bg behind a widget's output that resets the style
// inside it (the bubbles inputs pad with unstyled spaces).
func onBackground(s string, bg lipgloss.Color) string {
	styled := lipgloss.NewStyle().Background(bg).Render("x")
	prefix := styled[:strings.Index(styled, "x")]

	if prefix == "" {
		return s
	}

	return prefix + strings.ReplaceAll(s, "\x1b[0m", "\x1b[0m"+prefix)
}
