package main

import (
	"github.com/atotto/clipboard"
	"github.com/muesli/termenv"
)

// copyText puts text into the system clipboard (xclip, wl-copy, pbcopy,
// …), or asks the terminal to (OSC 52) where there is none, e.g. over SSH.
func copyText(text string) error {
	if err := clipboard.WriteAll(text); err == nil {
		return nil
	}

	termenv.DefaultOutput().Copy(text)

	return nil
}

// clearClipboardIf empties the clipboard if it still holds text.
func clearClipboardIf(text string) {
	if current, err := clipboard.ReadAll(); err == nil && current == text {
		_ = clipboard.WriteAll("")
	}
}
