package main

import "github.com/charmbracelet/lipgloss"

// The "DEV" badge next to developer accounts' names, drawn as three
// segments along the app's gradient (#7C7BF0 → #44AAB8 → #7FED53) with
// dark letters. Terminals without 24-bit color get the nearest colors.
var devBadgeSegments = []struct {
	text       string
	background string
}{
	{" D", "#7C7BF0"},
	{"E", "#44AAB8"},
	{"V ", "#7FED53"},
}

func devBadge() string {
	badge := ""

	for _, segment := range devBadgeSegments {
		badge += lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#071036")).
			Background(lipgloss.Color(segment.background)).
			Render(segment.text)
	}

	return badge
}

// withDevBadge appends the badge (after a space) for developer accounts.
func withDevBadge(name string, isDeveloper bool) string {
	if !isDeveloper {
		return name
	}

	return name + " " + devBadge()
}
