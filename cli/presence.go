package main

import (
	"fmt"
	"time"
)

type presence struct {
	online   bool
	lastSeen *time.Time
}

func parseTime(value *string) *time.Time {
	if value == nil {
		return nil
	}

	t, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil
	}

	return &t
}

// formatPresence returns "online", "last seen 5 min ago", "last seen today
// at 14:05", ... or "" when nothing is known yet.
func formatPresence(p *presence, now time.Time) string {
	if p == nil {
		return ""
	}

	if p.online {
		return "online"
	}

	// Hidden (privacy settings, or they have not written to you yet):
	// say nothing precise.
	if p.lastSeen == nil {
		return "last seen recently"
	}

	seen := p.lastSeen.Local()
	ago := now.Sub(seen)

	switch {
	case ago < time.Minute:
		return "last seen just now"

	case ago < time.Hour:
		return fmt.Sprintf("last seen %d min ago", int(ago.Minutes()))
	}

	clock := seen.Format("15:04")
	y, m, d := seen.Date()
	ny, nm, nd := now.Date()
	yy, ym, yd := now.AddDate(0, 0, -1).Date()

	switch {
	case y == ny && m == nm && d == nd:
		return "last seen today at " + clock

	case y == yy && m == ym && d == yd:
		return "last seen yesterday at " + clock

	case y == ny:
		return "last seen " + seen.Format("02.01") + " at " + clock
	}

	return "last seen " + seen.Format("02.01.2006") + " at " + clock
}

// localTime parses a server timestamp into local time.
func localTime(iso string) (time.Time, bool) {
	t := parseTime(&iso)

	if t == nil {
		return time.Time{}, false
	}

	return t.Local(), true
}

// formatTime: "14:05", for message bubbles.
func formatTime(iso string) string {
	t, ok := localTime(iso)

	if !ok {
		return ""
	}

	return t.Format("15:04")
}

// formatChatDate: "14:05" today, "12.09" this year, "12.09.2025" before.
func formatChatDate(iso string) string {
	t, ok := localTime(iso)

	if !ok {
		return ""
	}

	now := time.Now()

	switch {
	case sameDay(t, now):
		return t.Format("15:04")
	case t.Year() == now.Year():
		return t.Format("02.01")
	}

	return t.Format("02.01.2006")
}

// formatDate: "12.09.2025".
func formatDate(iso string) string {
	t, ok := localTime(iso)

	if !ok {
		return ""
	}

	return t.Format("02.01.2006")
}

// formatDayLabel: day separators in a chat: "Today", "Yesterday",
// "12 September", "12 September 2025".
func formatDayLabel(iso string) string {
	t, ok := localTime(iso)

	if !ok {
		return ""
	}

	now := time.Now()

	switch {
	case sameDay(t, now):
		return "Today"
	case sameDay(t, now.AddDate(0, 0, -1)):
		return "Yesterday"
	case t.Year() == now.Year():
		return t.Format("2 January")
	}

	return t.Format("2 January 2006")
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()

	return ay == by && am == bm && ad == bd
}
