package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

const usage = `Ostrich: an end-to-end encrypted messenger in the terminal.

Usage: ostrich [--version | --help]

Environment:
  OSTRICH_SERVER=URL           use another server
  OSTRICH_NO_UPDATE_CHECK=1    do not look for new releases
`

func main() {
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--version", "-v", "version":
			fmt.Println("ostrich", version)
			return
		case "--help", "-h", "help":
			fmt.Print(usage)
			return
		default:
			fmt.Fprintf(os.Stderr, "ostrich: unknown argument %q\n\n%s", arg, usage)
			os.Exit(2)
		}
	}

	zone.NewGlobal()

	// The "system" theme follows the terminal's background, asked before
	// the program takes over the terminal.
	systemDark := true

	if loadConfig().Theme == "system" {
		systemDark = lipgloss.HasDarkBackground()
	}

	// A remembered session ("Remember me"); read before the program takes
	// over the terminal, as the keyring may ask to be unlocked.
	saved := loadSession()

	program := tea.NewProgram(
		newModel(systemDark, saved),
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "ostrich:", err)
		os.Exit(1)
	}
}
