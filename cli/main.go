package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	zone "github.com/lrstanley/bubblezone"
)

func main() {
	zone.NewGlobal()

	// The "system" theme follows the terminal's background, asked before
	// the program takes over the terminal.
	systemDark := true

	if loadConfig().Theme == "system" {
		systemDark = lipgloss.HasDarkBackground()
	}

	program := tea.NewProgram(
		newModel(systemDark),
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "ostrich:", err)
		os.Exit(1)
	}
}
