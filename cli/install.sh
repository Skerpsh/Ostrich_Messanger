#!/bin/sh
# Installs the latest Ostrich CLI release for this computer:
#
#   curl -fsSL https://github.com/Skerpsh/Ostrich_Messenger/releases/latest/download/install.sh | sh
#
# Into ~/.local/bin (or INSTALL_DIR=/usr/local/bin with sudo). The download
# is checked against the release's SHA256SUMS. OSTRICH_RELEASE_BASE points
# it at another copy of the release files (for testing).
set -eu

repo="Skerpsh/Ostrich_Messenger"
base="${OSTRICH_RELEASE_BASE:-https://github.com/$repo/releases/latest/download}"
dir="${INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "install.sh: on Windows, download ostrich-windows-amd64.exe from https://github.com/$repo/releases/latest" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "install.sh: no build for $(uname -m)" >&2; exit 1 ;;
esac

name="ostrich-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $name…"
curl -fsSL -o "$tmp/$name" "$base/$name"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

expected="$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"

if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$tmp/$name" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"
fi

if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "install.sh: checksum mismatch, not installing" >&2
  exit 1
fi

mkdir -p "$dir"
chmod +x "$tmp/$name"
mv "$tmp/$name" "$dir/ostrich"

echo "Installed $("$dir/ostrich" --version) to $dir/ostrich"

case ":$PATH:" in
  *":$dir:"*) echo "Run: ostrich" ;;
  *) echo "Add $dir to PATH, or run: $dir/ostrich" ;;
esac
