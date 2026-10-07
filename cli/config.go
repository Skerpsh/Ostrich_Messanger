package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Preferences of this computer, like the web's per-device settings:
// ~/.config/ostrich/settings.json (or the platform's config directory).
type config struct {
	// "system", "light" or "dark".
	Theme string `json:"theme"`
	// An accent id (theme.go).
	Accent string `json:"accent"`
	// Ring the terminal bell for new messages in other chats.
	Bell bool `json:"bell"`
}

func configPath() (string, bool) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", false
	}

	return filepath.Join(dir, "ostrich", "settings.json"), true
}

func loadConfig() config {
	cfg := config{Theme: "system", Accent: defaultAccent, Bell: true}

	if path, ok := configPath(); ok {
		if data, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(data, &cfg)
		}
	}

	switch cfg.Theme {
	case "system", "light", "dark":
	default:
		cfg.Theme = "system"
	}

	cfg.Accent = findAccent(cfg.Accent).id

	return cfg
}

// save writes the preferences; failures are ignored (the choice then
// lasts until the CLI is closed).
func (cfg config) save() {
	path, ok := configPath()
	if !ok {
		return
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}

	tmp := path + ".tmp"

	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}
