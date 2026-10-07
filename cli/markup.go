package main

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Text formatting in messages, the same as the app's
// (frontend/src/lib/markup.ts): **bold**, *italic* or _italic_,
// ~~strikethrough~~, `code`, ```code block```; links are found by
// themselves.

type spanStyle struct {
	bold, italic, strike, code bool
	link                       string
}

type span struct {
	text  string
	style spanStyle
}

// wordRune is JavaScript's \w.
func wordRune(r rune) bool {
	return r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_')
}

func runeAt(text []rune, i int) rune {
	if i < 0 || i >= len(text) {
		return 0
	}

	return text[i]
}

// markupMatch is a formatted part found at [start, end); content is what
// it shows.
type markupMatch struct {
	start, end int
	content    string
	style      spanStyle
	// Formatting inside is parsed too (not in code and links).
	inner bool
}

func hasPrefixAt(text []rune, i int, prefix string) bool {
	p := []rune(prefix)

	if i+len(p) > len(text) {
		return false
	}

	for j, r := range p {
		if text[i+j] != r {
			return false
		}
	}

	return true
}

// matchAt finds a formatted part starting exactly at i.
func matchAt(text []rune, i int) (markupMatch, bool) {
	switch {
	case hasPrefixAt(text, i, "```"):
		for j := i + 3; j+3 <= len(text); j++ {
			if hasPrefixAt(text, j, "```") && j > i+3 {
				content := strings.TrimSuffix(strings.TrimPrefix(string(text[i+3:j]), "\n"), "\n")

				if content != "" {
					return markupMatch{i, j + 3, content, spanStyle{code: true}, false}, true
				}
			}
		}
	case text[i] == '`':
		for j := i + 1; j < len(text) && text[j] != '\n'; j++ {
			if text[j] == '`' {
				if j > i+1 {
					return markupMatch{i, j + 1, string(text[i+1 : j]), spanStyle{code: true}, false}, true
				}

				break
			}
		}
	case hasPrefixAt(text, i, "**"), hasPrefixAt(text, i, "~~"):
		marker := string(text[i : i+2])

		if unicode.IsSpace(runeAt(text, i+2)) || i+2 >= len(text) {
			break
		}

		for j := i + 3; j+2 <= len(text); j++ {
			if hasPrefixAt(text, j, marker) && !unicode.IsSpace(text[j-1]) {
				style := spanStyle{bold: true}

				if marker == "~~" {
					style = spanStyle{strike: true}
				}

				return markupMatch{i, j + 2, string(text[i+2 : j]), style, true}, true
			}
		}
	case text[i] == '*' || text[i] == '_':
		m := text[i]
		next := runeAt(text, i+1)

		if wordRune(runeAt(text, i-1)) || runeAt(text, i-1) == m || next == 0 || unicode.IsSpace(next) || next == m {
			break
		}

		for j := i + 1; j < len(text) && text[j] != '\n'; j++ {
			if text[j] != m {
				continue
			}

			prev, after := text[j-1], runeAt(text, j+1)

			if !unicode.IsSpace(prev) && prev != m && !wordRune(after) && after != m {
				return markupMatch{i, j + 1, string(text[i+1 : j]), spanStyle{italic: true}, true}, true
			}

			break
		}
	case hasPrefixAt(text, i, "http://") || hasPrefixAt(text, i, "https://"):
		if wordRune(runeAt(text, i-1)) {
			break
		}

		j := i

		for j < len(text) && !unicode.IsSpace(text[j]) && !strings.ContainsRune(`<>"`, text[j]) {
			j++
		}

		for j > i && strings.ContainsRune(`.,;:!?)]}'"`, text[j-1]) {
			j--
		}

		if link := string(text[i:j]); len(link) > len("https://") {
			return markupMatch{i, j, link, spanStyle{link: link}, false}, true
		}
	}

	return markupMatch{}, false
}

func parseMarkup(text string) []span {
	return parseStyled([]rune(text), spanStyle{})
}

func parseStyled(text []rune, outer spanStyle) []span {
	var spans []span
	plainFrom := 0

	for i := 0; i < len(text); i++ {
		match, ok := matchAt(text, i)

		if !ok {
			continue
		}

		if i > plainFrom {
			spans = append(spans, span{string(text[plainFrom:i]), outer})
		}

		style := combine(outer, match.style)

		if match.inner && !outer.code {
			spans = append(spans, parseStyled([]rune(match.content), style)...)
		} else {
			spans = append(spans, span{match.content, style})
		}

		i = match.end - 1
		plainFrom = match.end
	}

	if plainFrom < len(text) {
		spans = append(spans, span{string(text[plainFrom:]), outer})
	}

	return spans
}

func combine(a, b spanStyle) spanStyle {
	return spanStyle{
		bold:   a.bold || b.bold,
		italic: a.italic || b.italic,
		strike: a.strike || b.strike,
		code:   a.code || b.code,
		link:   a.link + b.link,
	}
}

// plainText is the text without the markers, for previews.
func plainText(text string) string {
	var b strings.Builder

	for _, s := range parseMarkup(text) {
		b.WriteString(s.text)
	}

	return b.String()
}

// markupLines draws formatted text wrapped to w cells: words move to the
// next line whole, longer ones are cut. Code is drawn on codeBg, links
// underlined in linkFg.
func markupLines(text string, w int, fg, bg, codeBg, linkFg lipgloss.Color) []string {
	type cell struct {
		r     rune
		style spanStyle
	}

	var paragraphs [][]cell
	current := []cell{}

	for _, s := range parseMarkup(text) {
		for _, r := range s.text {
			if r == '\n' {
				paragraphs = append(paragraphs, current)
				current = []cell{}

				continue
			}

			current = append(current, cell{r, s.style})
		}
	}

	paragraphs = append(paragraphs, current)

	cellWidth := func(c cell) int { return max(ansi.StringWidth(string(c.r)), 0) }

	var lines [][]cell

	for _, paragraph := range paragraphs {
		var line []cell
		used := 0

		// Words with the spaces before them.
		for i := 0; i < len(paragraph); {
			j := i

			for j < len(paragraph) && paragraph[j].r == ' ' {
				j++
			}

			spaces := paragraph[i:j]
			k := j

			for k < len(paragraph) && paragraph[k].r != ' ' {
				k++
			}

			word := paragraph[j:k]
			wordW := 0

			for _, c := range word {
				wordW += cellWidth(c)
			}

			if used > 0 && used+len(spaces)+wordW > w {
				lines = append(lines, line)
				line, used, spaces = nil, 0, nil
			}

			line = append(line, spaces...)
			used += len(spaces)

			for _, c := range word {
				if cw := cellWidth(c); used+cw > w && used > 0 {
					lines = append(lines, line)
					line, used = nil, 0
				}

				line = append(line, c)
				used += cellWidth(c)
			}

			i = k
		}

		lines = append(lines, line)
	}

	out := make([]string, len(lines))

	for i, line := range lines {
		var b strings.Builder

		for j := 0; j < len(line); {
			k := j

			for k < len(line) && line[k].style == line[j].style {
				k++
			}

			runes := make([]rune, 0, k-j)

			for _, c := range line[j:k] {
				runes = append(runes, c.r)
			}

			st := line[j].style
			style := lipgloss.NewStyle().Foreground(fg).Background(bg).
				Bold(st.bold).Italic(st.italic).Strikethrough(st.strike)

			if st.code {
				style = style.Background(codeBg)
			}

			if st.link != "" {
				style = style.Foreground(linkFg).Underline(true)
			}

			b.WriteString(style.Render(string(runes)))
			j = k
		}

		out[i] = b.String()
	}

	return out
}
