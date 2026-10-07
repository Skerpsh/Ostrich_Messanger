package main

import tea "github.com/charmbracelet/bubbletea"

func main() {
	program := tea.NewProgram(
		newLoginModel(),
		tea.WithAltScreen(),
	)

	if _, err := program.Run(); err != nil {
		panic(err)
	}
}
