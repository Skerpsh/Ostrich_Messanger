package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The version of this build: set by the release workflow
// (-ldflags "-X main.version=v1.2.0"); "dev" for local builds.
var version = "dev"

const (
	repository  = "Skerpsh/Ostrich_Messenger"
	releasesURL = "https://github.com/" + repository + "/releases/latest"
)

// newerRelease returns the latest release's version if it is newer than
// this build; "" otherwise, also for local builds or without network.
// OSTRICH_NO_UPDATE_CHECK=1 turns the check off.
func newerRelease() string {
	if version == "dev" || os.Getenv("OSTRICH_NO_UPDATE_CHECK") != "" {
		return ""
	}

	client := http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get("https://api.github.com/repos/" + repository + "/releases/latest")
	if err != nil {
		return ""
	}

	defer resp.Body.Close()

	var release struct {
		TagName string `json:"tag_name"`
	}

	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&release) != nil {
		return ""
	}

	if newerVersion(release.TagName, version) {
		return release.TagName
	}

	return ""
}

// newerVersion tells whether version a ("v1.2.3") is newer than b.
func newerVersion(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)

	if pa == nil || pb == nil {
		return false
	}

	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}

	return false
}

func versionParts(v string) []int {
	fields := strings.Split(strings.TrimPrefix(v, "v"), ".")

	if len(fields) != 3 {
		return nil
	}

	parts := make([]int, 3)

	for i, field := range fields {
		// "1.2.3-beta" counts as 1.2.3.
		field, _, _ = strings.Cut(field, "-")
		n, err := strconv.Atoi(field)

		if err != nil {
			return nil
		}

		parts[i] = n
	}

	return parts
}

// checkForUpdate tells about a newer release, once, at start.
func checkForUpdate() tea.Cmd {
	return task(func() func(*model) tea.Cmd {
		latest := newerRelease()

		return func(m *model) tea.Cmd {
			if latest == "" {
				return nil
			}

			return m.showToast("Ostrich "+latest+" is out: "+releasesURL, false)
		}
	})
}
