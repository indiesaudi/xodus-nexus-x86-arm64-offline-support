#!/usr/bin/env bash
# Nexus Launcher user installer.
#
# One-liner (once the repository is public):
#   curl -fsSL https://raw.githubusercontent.com/domsvoboda/nexus-launcher/main/scripts/install.sh | bash
#
# An interactive run asks whether to install a fresh copy or upgrade an existing
# installation. For noninteractive use pass --install or --upgrade, for example:
#   curl -fsSL https://raw.githubusercontent.com/domsvoboda/nexus-launcher/main/scripts/install.sh | bash -s -- --upgrade
#
# What it does, without further input:
#   1. Installs system prerequisites with your package manager (skip with
#      XODUS_NEXUS_SKIP_DEPS=1): backend sign-in and Electron runtime libraries.
#      Rust/Cargo/protoc are not needed for the prebuilt backend.
#   2. Downloads the latest Nexus Launcher AppImage from GitHub Releases and
#      verifies its published SHA-512 checksum.
#   3. Installs it to ~/.local/opt/xodus-nexus, links it into ~/.local/bin
#      and registers a desktop entry with the app icon.
#
# Settings, accounts, runtimes, prefixes, saves and games are never moved or
# rewritten. An upgrade replaces only the installer-owned launcher, command
# link, icon and application-menu entry.
#
# Environment overrides:
#   XODUS_NEXUS_SKIP_DEPS=1          do not touch system packages
#   XODUS_NEXUS_MODE=install|upgrade noninteractive menu selection
#   XODUS_NEXUS_APPIMAGE=<file>      install a local AppImage instead of downloading
#   XODUS_NEXUS_APPIMAGE_SHA512=<hex> verify that local AppImage
#   XODUS_NEXUS_PREFIX=<dir>         installation prefix (default ~/.local)
#   XDG_DATA_HOME=<dir>              application-menu data directory
set -euo pipefail

REPO_PRIMARY=domsvoboda/nexus-launcher
REPO_FALLBACK=domsvoboda/xodus-nexus

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m -> %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--install|--upgrade] [--skip-deps]

Install Nexus Launcher from the latest stable GitHub release.

Modes:
  --install     install a fresh copy; refuse when an installation already exists
  --upgrade     replace an existing installer-managed launcher; keep user data
  --skip-deps   do not touch system packages
  -h, --help    show this help

Without a mode, an interactive terminal shows a choice between Install and
Upgrade. The prompt reads from /dev/tty, so "curl ... | bash" works. When no
terminal is available, pass --install or --upgrade, for example:
  curl ... | bash -s -- --upgrade

Environment overrides:
  XODUS_NEXUS_MODE=install|upgrade
  XODUS_NEXUS_SKIP_DEPS=1
  XODUS_NEXUS_APPIMAGE=<file>
  XODUS_NEXUS_APPIMAGE_SHA512=<hex>
  XODUS_NEXUS_PREFIX=<dir>
  XDG_DATA_HOME=<dir>

An upgrade always uses the latest stable release and does not run an
intermediate launcher version. Existing games, saves, settings, accounts,
runtimes and prefixes are left in place.
EOF
}

desktop_quote() {
  local quoted
  quoted=$(printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/`/\\\\`/g' -e 's/\$/\\\\$/g' -e 's/%/%%/g')
  printf '"%s"' "$quoted"
}

desktop_value() {
  local value=$1
  value=${value//\\/\\\\}
  printf '%s' "$value"
}

reject_control_path() {
  local value=$1 label=$2
  case "$value" in
    *[$'\001'-$'\037'$'\177']*)
      die "$label contains control characters and cannot be used in a desktop entry."
      ;;
  esac
}

# ---------------------------------------------------------------- arguments
HELP=0
for argument in "$@"; do
  if [[ "$argument" == "-h" || "$argument" == "--help" ]]; then
    HELP=1
  fi
done
if [[ "$HELP" -eq 1 ]]; then
  usage
  exit 0
fi

MODE_ARGUMENT=''
SKIP_DEPS="${XODUS_NEXUS_SKIP_DEPS:-0}"
for argument in "$@"; do
  case "$argument" in
    --install)
      if [[ -n "$MODE_ARGUMENT" && "$MODE_ARGUMENT" != install ]]; then
        die "Choose either --install or --upgrade, not both."
      fi
      MODE_ARGUMENT=install
      ;;
    --upgrade)
      if [[ -n "$MODE_ARGUMENT" && "$MODE_ARGUMENT" != upgrade ]]; then
        die "Choose either --install or --upgrade, not both."
      fi
      MODE_ARGUMENT=upgrade
      ;;
    --skip-deps) SKIP_DEPS=1 ;;
    *) die "Unknown option: $argument. Use --help for usage." ;;
  esac
done

if [[ -n "$MODE_ARGUMENT" ]]; then
  if [[ -n "${XODUS_NEXUS_MODE:-}" && "${XODUS_NEXUS_MODE}" != "$MODE_ARGUMENT" ]]; then
    die "XODUS_NEXUS_MODE=${XODUS_NEXUS_MODE} conflicts with ${MODE_ARGUMENT}."
  fi
  MODE="$MODE_ARGUMENT"
elif [[ -n "${XODUS_NEXUS_MODE:-}" ]]; then
  case "$XODUS_NEXUS_MODE" in
    install|upgrade) MODE="$XODUS_NEXUS_MODE" ;;
    *) die "Invalid XODUS_NEXUS_MODE=${XODUS_NEXUS_MODE}; use install or upgrade." ;;
  esac
else
  MODE=''
fi

case "$SKIP_DEPS" in
  0|1) ;;
  *) die "XODUS_NEXUS_SKIP_DEPS must be 0 or 1." ;;
esac

# ------------------------------------------------------------------- paths
[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only."
case "$(uname -m)" in
  x86_64) APPIMAGE_ARCH=x86_64 ;;
  aarch64) APPIMAGE_ARCH=arm64 ;;
  *) die "Only x86_64 and aarch64 builds are published." ;;
esac
command -v curl >/dev/null || die "curl is required to run this installer."
command -v sha512sum >/dev/null || die "sha512sum is required to verify the launcher."

[[ -n "${HOME:-}" ]] || die "HOME must be set."
raw_prefix="${XODUS_NEXUS_PREFIX:-$HOME/.local}"
raw_desktop_base="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$raw_prefix" == /* ]] || die "XODUS_NEXUS_PREFIX must be an absolute path."
[[ "$raw_desktop_base" == /* ]] || die "XDG_DATA_HOME must be an absolute path."
reject_control_path "$raw_prefix" "XODUS_NEXUS_PREFIX"
reject_control_path "$raw_desktop_base" "XDG_DATA_HOME"
[[ -x /usr/bin/env ]] || die "/usr/bin/env is required for the application-menu launcher."
if [[ "$raw_prefix" == *=* ]]; then
  die "XODUS_NEXUS_PREFIX contains '=', which /usr/bin/env cannot pass as a command path."
fi
# Lexical normalization only: trailing slashes, '.', '..' and duplicate
# separators are removed, but symlink components remain unchanged.
PREFIX="$(realpath -ms -- "$raw_prefix")"
DESKTOP_BASE="$(realpath -ms -- "$raw_desktop_base")"
APP_DIR="$PREFIX/opt/xodus-nexus"
BIN_DIR="$PREFIX/bin"
DESKTOP_DIR="$DESKTOP_BASE/applications"
# Fresh installations use the current Nexus-Launcher asset name. An existing
# legacy Xodus-Nexus installation is updated in place so its command link and
# updater backups keep working.
canonical_target="$APP_DIR/Nexus-Launcher.AppImage"
legacy_target="$APP_DIR/Xodus-Nexus.AppImage"
if [[ -e "$canonical_target" || -L "$canonical_target" ]]; then
  target="$canonical_target"
elif [[ -e "$legacy_target" || -L "$legacy_target" ]]; then
  target="$legacy_target"
else
  target="$canonical_target"
fi
icon="$APP_DIR/icon.png"
command="$BIN_DIR/xodus-nexus"
desktop="$DESKTOP_DIR/xodus-nexus.desktop"
# Raw legacy forms used by the 0.4.x installer. They are recognized for
# ownership checks but never written by this version.
raw_command="$raw_prefix/bin/xodus-nexus"
raw_icon="$raw_prefix/opt/xodus-nexus/icon.png"
env_exec="/usr/bin/env -- $(desktop_quote "$command") %U"
LOCAL_APPIMAGE="${XODUS_NEXUS_APPIMAGE:-}"
LOCAL_APPIMAGE_SHA512="${XODUS_NEXUS_APPIMAGE_SHA512:-}"

# ------------------------------------------------------------ owned layout
owned_by_me() {
  [[ "$(stat -c '%u' -- "$1")" == "$EUID" ]]
}

path_equivalent() {
  [[ "$(realpath -ms -- "$1")" == "$(realpath -ms -- "$2")" ]]
}

desktop_icon_is_owned() {
  local icon_line candidate
  icon_line=$(awk 'substr($0,1,5)=="Icon="{print substr($0,6); exit}' "$desktop") || return 1
  for candidate in "$icon" "$(desktop_value "$icon")" "$raw_icon" "$(desktop_value "$raw_icon")"; do
    if [[ "$icon_line" == "$candidate" ]]; then return 0; fi
  done
  path_equivalent "$icon_line" "$icon" && return 0
  return 1
}

desktop_is_owned() {
  [[ -f "$desktop" && ! -L "$desktop" ]] || return 1
  if ! grep -Fxq -- 'Name=Xodus Nexus' "$desktop" && ! grep -Fxq -- 'Name=Nexus Launcher' "$desktop"; then
    return 1
  fi
  local exec_line candidate exec_path
  exec_line=$(awk 'substr($0,1,5)=="Exec="{print substr($0,6); exit}' "$desktop") || return 1
  for candidate in "$env_exec" "$command %U" "$(desktop_quote "$command") %U" "$raw_command %U" "$(desktop_quote "$raw_command") %U"; do
    if [[ "$exec_line" == "$candidate" ]]; then
      desktop_icon_is_owned && return 0
      return 1
    fi
  done
  if [[ "$exec_line" == *" %U" && "$exec_line" != \"* ]]; then
    exec_path="${exec_line% %U}"
    if path_equivalent "$exec_path" "$command" && desktop_icon_is_owned; then
      return 0
    fi
  fi
  return 1
}

link_is_owned() {
  [[ -L "$command" ]] || return 1
  local current
  current="$(realpath -m -- "$command")"
  # Accept either installer-owned image so a legacy link can be updated to the
  # selected target (current main behavior) instead of being rejected when both
  # the canonical and legacy images happen to exist.
  [[ "$current" == "$(realpath -m -- "$canonical_target")" || "$current" == "$(realpath -m -- "$legacy_target")" ]]
}

installation_exists() {
  if [[ -e "$target" || -L "$target" ]]; then return 0; fi
  if link_is_owned; then return 0; fi
  if desktop_is_owned; then return 0; fi
  return 1
}

require_install_mode() {
  if [[ -e "$target" || -L "$target" ]]; then
    die "An existing installation was found at $target. Choose Upgrade (2) or run --upgrade. --install does not overwrite an existing installation."
  fi
  if installation_exists; then
    die "An incomplete installation was found: $target is missing but its command link or menu entry exists. Remove those leftovers and run --install."
  fi
}

require_upgrade_mode() {
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    if installation_exists; then
      die "An incomplete installation was found: $target is missing but its command link or menu entry exists. Remove those leftovers and run --install."
    fi
    die "No installed launcher was found at $target. Choose Install (1) or run --install."
  fi
  if [[ -L "$target" ]]; then
    die "The installed launcher path is a symlink: $target. Move it away and retry the upgrade."
  fi
  [[ -f "$target" ]] || die "The installed launcher path is not a regular file: $target."
}

check_layout() {
  if [[ -L "$APP_DIR" ]]; then
    die "Refusing to use a symlinked application directory: $APP_DIR"
  fi
  if [[ -e "$APP_DIR" && ! -d "$APP_DIR" ]]; then
    die "The application path is not a directory: $APP_DIR"
  fi
  if [[ -e "$APP_DIR" ]] && ! owned_by_me "$APP_DIR"; then
    die "The application directory is owned by another user: $APP_DIR"
  fi
  if [[ -L "$target" ]]; then
    die "Refusing to replace a symlinked launcher file: $target. Move it away and retry."
  fi
  if [[ -e "$target" && ! -f "$target" ]]; then
    die "The launcher path is not a regular file: $target"
  fi
  if [[ -e "$target" ]] && ! owned_by_me "$target"; then
    die "The launcher file is owned by another user: $target"
  fi
  if [[ -e "$command" || -L "$command" ]]; then
    if ! link_is_owned; then
      die "The command path was not created by this installer: $command. Move it away and retry."
    fi
    if ! owned_by_me "$command"; then
      die "The command link is owned by another user: $command"
    fi
  fi
  if [[ -e "$desktop" || -L "$desktop" ]]; then
    if [[ -L "$desktop" || ! -f "$desktop" ]]; then
      die "The application-menu entry is not a regular file: $desktop. Not overwriting it."
    fi
    if ! desktop_is_owned; then
      die "The application-menu entry was not created by this installer: $desktop. Move it away and retry."
    fi
    if ! owned_by_me "$desktop"; then
      die "The application-menu entry is owned by another user: $desktop"
    fi
  fi
  if [[ -e "$icon" || -L "$icon" ]]; then
    if [[ -L "$icon" || ! -f "$icon" ]]; then
      die "The icon path is not a regular file: $icon. Not overwriting it."
    fi
    if ! owned_by_me "$icon"; then
      die "The icon file is owned by another user: $icon"
    fi
  fi
}

select_mode_interactive() {
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    die "No interactive terminal is available. Use --install or --upgrade, for example: bash -s -- --upgrade"
  fi
  local choice attempts=0
  if installation_exists; then
    printf '\nNexus Launcher installer\n  1) Install a fresh copy\n  2) Upgrade the existing installation\n\nExisting installation: %s\n' "$target" >&3
  else
    printf '\nNexus Launcher installer\n  1) Install a fresh copy\n  2) Upgrade an existing installation\n\nNo existing installation was found.\n' >&3
  fi
  while :; do
    printf 'Select 1 or 2: ' >&3
    if ! IFS= read -r -u 3 choice; then
      printf '\nError: No selection was received. Use --install or --upgrade.\n' >&3
      exec 3>&-
      exit 1
    fi
    choice="${choice//$'\r'/}"
    choice="${choice#"${choice%%[![:space:]]*}"}"
    choice="${choice%"${choice##*[![:space:]]}"}"
    case "$choice" in
      1) MODE=install; break ;;
      2) MODE=upgrade; break ;;
      *)
        attempts=$((attempts + 1))
        printf 'Invalid selection. Enter 1 or 2.\n' >&3
        if [[ "$attempts" -ge 5 ]]; then
          printf 'Error: No valid selection was received. Use --install or --upgrade.\n' >&3
          exec 3>&-
          exit 1
        fi
        ;;
    esac
  done
  exec 3>&-
}

if [[ -z "$MODE" ]]; then
  select_mode_interactive
fi
case "$MODE" in
  install) require_install_mode ;;
  upgrade) require_upgrade_mode ;;
  *) die "Invalid mode: $MODE" ;;
esac
check_layout

# --------------------------------------------------------------- transaction
stage=''
desktop_tmp=''
link_stage_dir=''
lock_temp=''
lock_acquired=0
activation_started=0
target_activated=0
command_activated=0
desktop_activated=0
icon_activated=0
old_target_exists=0
old_link_exists=0
old_desktop_exists=0
old_icon_exists=0
old_link_target=''
ICON_STAGED=0
RELEASE_VERSION=''
RELEASE_REPO=''
DOWNLOAD_URL=''
LOCK_FILE="$target.nexus-update.lock"

rollback() {
  local restore_failed=0
  if [[ "$target_activated" -eq 1 ]]; then
    if [[ "$old_target_exists" -eq 1 ]]; then
      mv -f -- "$stage/old-image" "$target" || restore_failed=1
    else
      rm -f -- "$target" || restore_failed=1
    fi
  fi
  if [[ "$command_activated" -eq 1 ]]; then
    if [[ "$old_link_exists" -eq 1 ]]; then
      ln -sfn -- "$old_link_target" "$command" || restore_failed=1
    else
      rm -f -- "$command" || restore_failed=1
    fi
  fi
  if [[ "$desktop_activated" -eq 1 ]]; then
    if [[ "$old_desktop_exists" -eq 1 ]]; then
      mv -f -- "$stage/old.desktop" "$desktop" || restore_failed=1
    else
      rm -f -- "$desktop" || restore_failed=1
    fi
  fi
  if [[ "$icon_activated" -eq 1 ]]; then
    if [[ "$old_icon_exists" -eq 1 ]]; then
      mv -f -- "$stage/old.icon" "$icon" || restore_failed=1
    else
      rm -f -- "$icon" || restore_failed=1
    fi
  fi
  if [[ "$restore_failed" -ne 0 ]]; then
    warn "The previous installation could not be fully restored."
    return 1
  fi
  return 0
}

release_update_lock() {
  local pid
  if [[ "$lock_acquired" -eq 1 ]]; then
    if [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" && -O "$LOCK_FILE" ]]; then
      IFS= read -r pid < "$LOCK_FILE" || true
      pid="${pid%$'\r'}"
      if [[ "$pid" == "$$" ]]; then
        rm -f -- "$LOCK_FILE"
      fi
    fi
  fi
  lock_acquired=0
}

acquire_update_lock() {
  local attempts=0 existing_pid current_pid candidate
  while :; do
    candidate="$(mktemp "$APP_DIR/.nexus-lock.XXXXXX")"
    lock_temp="$candidate"
    printf '%s' "$$" > "$candidate"
    chmod 0600 "$candidate"
    if ln -T -- "$candidate" "$LOCK_FILE" 2>/dev/null; then
      lock_acquired=1
      rm -f -- "$candidate"
      lock_temp=''
      return 0
    fi
    rm -f -- "$candidate"
    lock_temp=''
    if [[ ! -e "$LOCK_FILE" && ! -L "$LOCK_FILE" ]]; then
      die "Could not create the launcher update lock: $LOCK_FILE"
    fi
    [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" && -O "$LOCK_FILE" ]] || die "Unsafe launcher update lock: $LOCK_FILE"
    IFS= read -r existing_pid < "$LOCK_FILE" || true
    existing_pid="${existing_pid%$'\r'}"
    [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] || die "Invalid launcher update lock: $LOCK_FILE"
    if kill -0 "$existing_pid" 2>/dev/null || [[ -d "/proc/$existing_pid" ]]; then
      die "A launcher update is active. Close Nexus Launcher and retry."
    fi
    IFS= read -r current_pid < "$LOCK_FILE" || true
    current_pid="${current_pid%$'\r'}"
    if [[ "$current_pid" != "$existing_pid" ]]; then
      attempts=$((attempts + 1))
      [[ "$attempts" -lt 3 ]] || die "The launcher update lock changed while acquiring it. Retry."
      continue
    fi
    warn "Removing a stale launcher update lock: $LOCK_FILE"
    rm -f -- "$LOCK_FILE"
    attempts=$((attempts + 1))
    [[ "$attempts" -lt 5 ]] || die "Could not acquire the launcher update lock: $LOCK_FILE"
  done
}

assert_update_lock_held() {
  local pid
  [[ "$lock_acquired" -eq 1 ]] || die "The launcher update lock was not acquired. Retry."
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" && -O "$LOCK_FILE" ]] || die "The launcher update lock was lost. Retry."
  IFS= read -r pid < "$LOCK_FILE" || true
  pid="${pid%$'\r'}"
  [[ "$pid" == "$$" ]] || die "The launcher update lock was replaced. Retry."
}

cleanup() {
  local status=$?
  local rollback_failed=0
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$activation_started" -eq 1 ]]; then
    rollback || rollback_failed=1
  fi
  release_update_lock
  if [[ -n "$lock_temp" ]]; then rm -f -- "$lock_temp"; fi
  if [[ "$rollback_failed" -eq 1 && -n "$stage" ]]; then
    warn "Recovery files were kept at: $stage"
  else
    if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi
  fi
  if [[ -n "$desktop_tmp" ]]; then rm -f -- "$desktop_tmp"; fi
  if [[ -n "$link_stage_dir" ]]; then rm -rf -- "$link_stage_dir"; fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p -- "$APP_DIR"
acquire_update_lock

# ---------------------------------------------------------------- system deps
install_deps() {
  local root="$1"; shift
  if [[ $EUID -eq 0 ]]; then
    "$root" "$@"
  elif command -v sudo >/dev/null; then
    sudo "$root" "$@"
  else
    warn "No sudo available; install these packages yourself: $*"
    return 0
  fi
}

if [[ "$SKIP_DEPS" -eq 1 ]]; then
  warn "Skipping system packages (XODUS_NEXUS_SKIP_DEPS=1)."
else
  source /etc/os-release 2>/dev/null || true
  distro="${ID:-unknown}"
  case "${ID_LIKE:-}" in
    *arch*) distro=arch ;;
    *debian*) distro=debian ;;
    *fedora*) distro=fedora ;;
  esac
  case "$distro" in
    arch)
      log "Installing prerequisites with pacman (Arch/CachyOS)…"
      install_deps pacman -S --needed --noconfirm \
        curl tar xz fuse2 \
        webkit2gtk-4.1 gtk3 nss libxtst desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    debian)
      log "Installing prerequisites with apt (Debian/Ubuntu)…"
      install_deps apt-get update -y || true
      # Newer distributions renamed some shared libraries for the time64 ABI.
      nexus_fuse=libfuse2; nexus_gtk=libgtk-3-0; nexus_alsa=libasound2
      if apt-cache show libfuse2t64 >/dev/null 2>&1; then nexus_fuse=libfuse2t64; fi
      if apt-cache show libgtk-3-0t64 >/dev/null 2>&1; then nexus_gtk=libgtk-3-0t64; fi
      if apt-cache show libasound2t64 >/dev/null 2>&1; then nexus_alsa=libasound2t64; fi
      install_deps apt-get install -y \
        curl tar xz-utils "$nexus_fuse" libwebkit2gtk-4.1-0 \
        "$nexus_gtk" libnss3 libxtst6 "$nexus_alsa" desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    fedora)
      log "Installing prerequisites with dnf (Fedora)…"
      install_deps dnf install -y \
        curl tar xz fuse \
        webkit2gtk4.1 gtk3 nss libXtst alsa-lib desktop-file-utils || warn "Some packages failed to install; continuing."
      ;;
    *)
      warn "Unknown distribution '$distro'; install these before first run:"
      warn "  curl tar xz fuse2 webkit2gtk-4.1 gtk3 nss libxtst"
      ;;
  esac
fi

# ------------------------------------------------------------ staging
mkdir -p -- "$BIN_DIR" "$DESKTOP_DIR"
stage="$(mktemp -d "$APP_DIR/.nexus-install.XXXXXX")"
link_stage_dir="$(mktemp -d "$BIN_DIR/.nexus-link.XXXXXX")"
ln -s -- "$target" "$link_stage_dir/link"

# ------------------------------------------------------------ release image
fetch_candidates() {
  local repo json url base
  for repo in "$REPO_PRIMARY" "$REPO_FALLBACK"; do
    if ! json="$(curl -fsSL --max-time 30 "https://api.github.com/repos/$repo/releases/latest")"; then
      if [[ "$repo" == "$REPO_PRIMARY" ]]; then
        warn "Could not read the latest release from $repo; trying the next source."
      fi
      continue
    fi
    api_tag=$(printf '%s\n' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/^"tag_name"[[:space:]]*:[[:space:]]*"([^"]*)"$/\1/' | sed -n '1p' || true)
    if [[ -z "$api_tag" ]]; then
      warn "Release metadata from $repo has no tag_name; skipping it."
      continue
    fi
    while IFS= read -r url; do
      base="${url##*/}"
      if [[ ! "$base" =~ ^(Xodus-Nexus|Nexus-Launcher)-([0-9]+\.[0-9]+\.[0-9]+)-${APPIMAGE_ARCH}\.AppImage$ ]]; then
        continue
      fi
      url_tag="${url#https://github.com/$repo/releases/download/}"
      url_tag="${url_tag%%/*}"
      if [[ "$url_tag" != "$api_tag" ]]; then
        warn "Ignoring a release asset whose tag does not match $api_tag."
        continue
      fi
      printf '%s\t%s\t%s\t%s\n' "${BASH_REMATCH[2]}" "$repo" "$url" "${BASH_REMATCH[1]}"
    done < <(printf '%s\n' "$json" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/^"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]*)"$/\1/' || true)
  done
}

select_release() {
  local candidates version selected
  candidates="$(fetch_candidates)"
  if [[ -z "$candidates" ]]; then
    die "No matching AppImage was found in the latest GitHub releases for this architecture ($APPIMAGE_ARCH). Publish a release first, or set XODUS_NEXUS_APPIMAGE=<file>."
  fi
  version="$(printf '%s\n' "$candidates" | cut -f1 | sort -V | tail -n1)"
  # Prefer the current Nexus-Launcher asset when the same release also carries
  # the legacy Xodus-Nexus family; fall back to the legacy family otherwise.
  selected="$(printf '%s\n' "$candidates" | awk -F'\t' -v version="$version" '
    $1 == version {
      if ($4 == "Nexus-Launcher" && !canonical) canonical = $0;
      else if (!legacy) legacy = $0;
    }
    END { print (canonical ? canonical : legacy) }')"
  RELEASE_VERSION="$version"
  RELEASE_REPO="$(printf '%s\n' "$selected" | cut -f2)"
  DOWNLOAD_URL="$(printf '%s\n' "$selected" | cut -f3)"
}

stage_downloaded_image() {
  local checksum_file="$stage/image.sha512sum" expected_hash expected_name actual_hash
  local release_path release_tag
  release_path="${DOWNLOAD_URL#https://github.com/$RELEASE_REPO/releases/download/}"
  release_tag="${release_path%%/*}"
  if [[ "$release_tag" != "v$RELEASE_VERSION" && "$release_tag" != "$RELEASE_VERSION" ]]; then
    die "The selected release asset does not match its version. The installed launcher was not changed."
  fi
  log "Downloading $(basename "$DOWNLOAD_URL") from the latest release ($RELEASE_VERSION)…"
  if ! curl -fSL --retry 3 --max-time 600 -o "$stage/image" "$DOWNLOAD_URL"; then
    die "Could not download the launcher AppImage. The installed launcher was not changed."
  fi
  chmod 0755 "$stage/image"
  if ! curl -fsSL --max-time 30 -o "$checksum_file" "${DOWNLOAD_URL}.sha512sum"; then
    die "The release does not provide the matching SHA-512 checksum. The installed launcher was not changed."
  fi
  IFS=' ' read -r expected_hash expected_name _ < "$checksum_file" || true
  expected_hash="${expected_hash%$'\r'}"
  expected_name="${expected_name%$'\r'}"
  expected_name="${expected_name#\*}"
  expected_hash="${expected_hash,,}"
  if [[ ! "$expected_hash" =~ ^[0-9a-f]{128}$ || "$expected_name" != "$(basename "$DOWNLOAD_URL")" ]]; then
    die "The release checksum file is invalid. The installed launcher was not changed."
  fi
  actual_hash="$(sha512sum < "$stage/image" | awk '{print $1}')"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    die "The launcher download failed SHA-512 verification. The installed launcher was not changed."
  fi
}

stage_local_image() {
  [[ -f "$LOCAL_APPIMAGE" ]] || die "XODUS_NEXUS_APPIMAGE points to a missing file: $LOCAL_APPIMAGE"
  log "Installing local AppImage: $LOCAL_APPIMAGE"
  cp -p -- "$LOCAL_APPIMAGE" "$stage/image" || die "Could not read the local AppImage: $LOCAL_APPIMAGE"
  chmod 0755 "$stage/image"
  if [[ -n "$LOCAL_APPIMAGE_SHA512" ]]; then
    local expected actual
    expected="${LOCAL_APPIMAGE_SHA512,,}"
    [[ "$expected" =~ ^[0-9a-f]{128}$ ]] || die "XODUS_NEXUS_APPIMAGE_SHA512 must be a SHA-512 hex digest."
    actual="$(sha512sum < "$stage/image" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || die "The local AppImage failed SHA-512 verification. The installed launcher was not changed."
  else
    warn "No SHA-512 checksum was provided for the local AppImage; installing the file exactly as given."
  fi
}

if [[ -n "$LOCAL_APPIMAGE" ]]; then
  RELEASE_VERSION=local
  RELEASE_REPO="$REPO_PRIMARY"
  stage_local_image
else
  select_release
  stage_downloaded_image
fi

if [[ -n "$LOCAL_APPIMAGE" ]]; then
  ICON_REPO="$REPO_PRIMARY"
else
  ICON_REPO="$RELEASE_REPO"
fi
if curl -fsSL --max-time 30 -o "$stage/icon.png" "https://raw.githubusercontent.com/$ICON_REPO/main/assets/icon.png"; then
  chmod 0644 "$stage/icon.png"
  ICON_STAGED=1
else
  rm -f -- "$stage/icon.png"
  ICON_STAGED=0
  warn "Could not download the icon; the existing icon or a generic icon will be used."
fi

desktop_tmp="$(mktemp "$DESKTOP_DIR/.xodus-nexus.desktop.XXXXXX")"
cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=Nexus Launcher
Comment=Open-source Xbox-inspired game launcher
Exec=$env_exec
Icon=$(desktop_value "$icon")
Terminal=false
Categories=Game;
StartupWMClass=xodus-nexus
EOF
chmod 0644 "$desktop_tmp"

# Re-check immediately before activation so a concurrently started in-app
# update cannot race the installer.
assert_update_lock_held

# ------------------------------------------- preserve old bytes for rollback
if [[ -f "$target" && ! -L "$target" ]]; then
  old_target_exists=1
  cp -p -- "$target" "$stage/old-image"
fi
if [[ -L "$command" ]]; then
  old_link_exists=1
  old_link_target="$(readlink -- "$command")"
fi
if [[ -f "$desktop" && ! -L "$desktop" ]]; then
  old_desktop_exists=1
  cp -p -- "$desktop" "$stage/old.desktop"
fi
if [[ -f "$icon" && ! -L "$icon" ]]; then
  old_icon_exists=1
  cp -p -- "$icon" "$stage/old.icon"
fi

# ------------------------------------------------------------- activate last
activate() {
  activation_started=1
  # Pre-mark each step so a failed or interrupted rename still triggers a
  # conservative rollback instead of discarding the previous bytes.
  target_activated=1
  mv -f -- "$stage/image" "$target"
  command_activated=1
  mv -Tf -- "$link_stage_dir/link" "$command"
  desktop_activated=1
  mv -f -- "$desktop_tmp" "$desktop"
  if [[ "$ICON_STAGED" -eq 1 ]]; then
    icon_activated=1
    mv -f -- "$stage/icon.png" "$icon"
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
  activation_started=0
  target_activated=0
  command_activated=0
  desktop_activated=0
  icon_activated=0
}
activate

if [[ "$RELEASE_VERSION" == "local" ]]; then
  display_version="local AppImage"
else
  display_version="$RELEASE_VERSION"
fi
if [[ "$MODE" == "upgrade" ]]; then
  log "Nexus Launcher upgrade complete ($display_version)."
  log "Existing games, saves, settings, accounts, runtimes and prefixes were kept."
else
  log "Nexus Launcher installed ($display_version)."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "Add $BIN_DIR to PATH to run 'xodus-nexus' from a terminal (usually already in ~/.profile)." ;;
esac

if [[ "$MODE" == "install" ]]; then
  cat <<'EOF'

First run:
  1. Start Nexus Launcher from your application menu (or: xodus-nexus).
  2. In Settings -> Xodus backend, click Install backend.
     This downloads and verifies our patched, prebuilt Xodus backend; no compiler needed.
  3. In Settings -> Nexus runtime, click Install Nexus runtime.
     This downloads our prebuilt runtime from GitHub Releases - no login,
     no compilation. The upstream snapshot and local source-build options are
     under Advanced / Diagnostics and are not needed for normal installation.
  4. Sign in via Xodus, then browse the Store and install your games.
EOF
fi
