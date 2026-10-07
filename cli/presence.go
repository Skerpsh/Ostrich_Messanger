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

	if p.lastSeen == nil {
		return "offline"
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
