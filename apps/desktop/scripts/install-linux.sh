#!/usr/bin/env bash
#
# Install cdz-nutz on Linux, from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/joe-lloyd/cdz-nuts/main/apps/desktop/scripts/install-linux.sh | bash
#
# Installs the AppImage to ~/.local/bin and writes a desktop entry so it shows
# up in your launcher. Nothing is installed system-wide and no root is needed.
#
# Uninstall:
#   rm ~/.local/bin/cdz-nutz ~/.local/share/applications/cdz-nutz.desktop
#
# Before 0.7.1 the app was called Homelab Music; its files are removed on install.
#
# The AppImage needs FUSE. On a box without it, run with --appimage-extract-and-run,
# or install libfuse2.

set -euo pipefail

REPO="joe-lloyd/cdz-nuts"
BIN_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/cdz-nutz"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Only x86_64 is built today; yours is $(uname -m)." >&2
  echo "Add your architecture to the release matrix in .github/workflows/release.yml." >&2
  exit 1
fi

echo "==> Looking up the latest release"
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o "https://[^\"]*\.AppImage" | head -1)

if [[ -z "${URL:-}" ]]; then
  echo "No AppImage in the latest release." >&2
  echo "Releases: https://github.com/$REPO/releases" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $(basename "$URL")"
curl -fsSL "$URL" -o "$TMP/cdz-nutz"
chmod +x "$TMP/cdz-nutz"

mkdir -p "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"
# Move into place last, so a failed download never replaces a working install.
mv "$TMP/cdz-nutz" "$BIN"

# The install from before the rename.
rm -f "$BIN_DIR/homelab-music" "$DESKTOP_DIR/homelab-music.desktop" "$ICON_DIR/homelab-music.png"

# Pull the icon out of the AppImage rather than shipping a second copy that can
# drift from the one the app itself uses.
if "$BIN" --appimage-extract 'usr/share/icons/hicolor/256x256/apps/*.png' >/dev/null 2>&1; then
  find squashfs-root -name '*.png' -exec cp {} "$ICON_DIR/cdz-nutz.png" \; 2>/dev/null || true
  rm -rf squashfs-root
fi

cat > "$DESKTOP_DIR/cdz-nutz.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=cdz-nutz
Comment=Tray player for the home music library
Exec=$BIN
Icon=cdz-nutz
Categories=AudioVideo;Audio;Player;
Terminal=false
StartupWMClass=homelab-music
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" || true

echo
echo "Installed: $BIN"
if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "Note: $BIN_DIR is not on your PATH. Either add it, or launch from your"
  echo "application menu, where the desktop entry just installed will appear."
fi
echo
echo "Run it:  cdz-nutz"
