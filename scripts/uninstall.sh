#!/usr/bin/env bash
# Remove the application-menu installation made by scripts/install.sh.
# Games, saves, settings, downloaded runtimes and wallet credentials are kept.
set -euo pipefail

nexus_dry_run=0
case "${1:-}" in
  --dry-run) nexus_dry_run=1 ;;
  -h|--help)
    cat <<'EOF'
Usage: uninstall.sh [--dry-run]

Close Nexus Launcher and its games before uninstalling. No sudo is needed.
Removes the installer-managed AppImage (including legacy Xodus-Nexus installs),
its updater backups, icon, command symlink and application-menu entry. All user
data and system packages are kept.
For a custom installation, use the same XODUS_NEXUS_PREFIX and XDG_DATA_HOME
values that were used with install.sh. --dry-run only lists matching files.
EOF
    exit 0 ;;
  '') ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { printf 'Expected at most one option.\n' >&2; exit 1; }

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Kept: %s\n' "$*" >&2; }
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
[[ -n "${HOME:-}" ]] || die 'HOME must be set.'
nexus_raw_prefix="${XODUS_NEXUS_PREFIX:-$HOME/.local}"
nexus_raw_data="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$nexus_raw_prefix" == /* && "$nexus_raw_data" == /* ]] || die 'Installation paths must be absolute.'
# Canonical paths locate files. Lexical and raw paths preserve installer
# spellings so trailing slashes and '.' components compare equivalently.
nexus_prefix="$(realpath -m -- "$nexus_raw_prefix")"
nexus_data="$(realpath -m -- "$nexus_raw_data")"
nexus_lexical_prefix="$(realpath -ms -- "$nexus_raw_prefix")"
nexus_app="$nexus_prefix/opt/xodus-nexus"
nexus_images=("$nexus_app/Nexus-Launcher.AppImage" "$nexus_app/Xodus-Nexus.AppImage")
nexus_command="$nexus_prefix/bin/xodus-nexus"
nexus_icon="$nexus_app/icon.png"
nexus_lexical_app="$nexus_lexical_prefix/opt/xodus-nexus"
nexus_lexical_command="$nexus_lexical_prefix/bin/xodus-nexus"
nexus_lexical_icon="$nexus_lexical_app/icon.png"
nexus_raw_app="$nexus_raw_prefix/opt/xodus-nexus"
nexus_raw_command="$nexus_raw_prefix/bin/xodus-nexus"
nexus_raw_icon="$nexus_raw_app/icon.png"
nexus_desktop_dir="$nexus_data/applications"
nexus_desktop="$nexus_desktop_dir/xodus-nexus.desktop"
nexus_env_exec="/usr/bin/env -- $(desktop_quote "$nexus_command") %U"
nexus_lexical_env_exec="/usr/bin/env -- $(desktop_quote "$nexus_lexical_command") %U"
nexus_exec_candidates=(
  "$nexus_env_exec"
  "$nexus_lexical_env_exec"
  "$nexus_command %U"
  "$(desktop_quote "$nexus_command") %U"
  "$nexus_raw_command %U"
  "$(desktop_quote "$nexus_raw_command") %U"
  "$nexus_lexical_command %U"
  "$(desktop_quote "$nexus_lexical_command") %U"
)
nexus_icon_candidates=(
  "$nexus_icon"
  "$(desktop_value "$nexus_icon")"
  "$nexus_raw_icon"
  "$(desktop_value "$nexus_raw_icon")"
  "$nexus_lexical_icon"
  "$(desktop_value "$nexus_lexical_icon")"
)
[[ ! -L "$nexus_app" ]] || die "The application directory is a symlink: $nexus_app"

# Do not race an in-app update, and never terminate a running process.
nexus_locks=()
for nexus_image in "${nexus_images[@]}"; do
  nexus_lock="$nexus_image.nexus-update.lock"
  if [[ -e "$nexus_lock" || -L "$nexus_lock" ]]; then
    [[ -f "$nexus_lock" && ! -L "$nexus_lock" && -O "$nexus_lock" ]] || die 'Unsafe launcher update lock.'
    nexus_pid=''
    IFS= read -r nexus_pid < "$nexus_lock" || true
    [[ "$nexus_pid" =~ ^[1-9][0-9]*$ ]] || die 'Invalid launcher update lock.'
    if kill -0 "$nexus_pid" 2>/dev/null; then die 'A launcher update is active. Close Nexus Launcher and retry.'; fi
    nexus_locks+=("$nexus_lock")
  fi
done

nexus_removed=0
remove_file() {
  local file="$1"
  [[ -e "$file" || -L "$file" ]] || return 0
  if [[ -d "$file" && ! -L "$file" ]]; then warn "directory $file"; return 0; fi
  if [[ "$(stat -c '%u' -- "$file")" != "$EUID" ]]; then warn "file owned by another user: $file"; return 0; fi
  if [[ "$nexus_dry_run" -eq 1 ]]; then
    printf 'Would remove: %s\n' "$file"
  else
    rm -f -- "$file"
    printf 'Removed: %s\n' "$file"
  fi
  nexus_removed=$((nexus_removed + 1))
}

if [[ -L "$nexus_command" ]]; then
  nexus_command_target="$(realpath -m -- "$nexus_command")"
  nexus_command_owned=0
  for nexus_image in "${nexus_images[@]}"; do
    if [[ "$nexus_command_target" == "$nexus_image" ]]; then nexus_command_owned=1; break; fi
  done
  if [[ "$nexus_command_owned" -eq 1 ]]; then remove_file "$nexus_command"
  else warn "unrelated command link $nexus_command"; fi
elif [[ -e "$nexus_command" ]]; then
  warn "command not created by the installer: $nexus_command"
fi
if [[ -f "$nexus_desktop" && ! -L "$nexus_desktop" ]]; then
  nexus_name_owned=0
  if grep -Fxq -- 'Name=Xodus Nexus' "$nexus_desktop" || grep -Fxq -- 'Name=Nexus Launcher' "$nexus_desktop"; then
    nexus_name_owned=1
  fi
  nexus_exec_owned=0
  for nexus_candidate in "${nexus_exec_candidates[@]}"; do
    if grep -Fxq -- "Exec=$nexus_candidate" "$nexus_desktop"; then nexus_exec_owned=1; break; fi
  done
  if [[ "$nexus_exec_owned" -eq 0 ]]; then
    nexus_exec_line=$(awk 'substr($0,1,5)=="Exec="{print substr($0,6); exit}' "$nexus_desktop") || true
    if [[ -n "$nexus_exec_line" && "$nexus_exec_line" == *" %U" && "$nexus_exec_line" != \"* ]]; then
      nexus_exec_path="${nexus_exec_line% %U}"
      if [[ -n "$nexus_exec_path" && "$(realpath -ms -- "$nexus_exec_path")" == "$(realpath -ms -- "$nexus_lexical_command")" ]]; then
        nexus_exec_owned=1
      fi
    fi
  fi
  nexus_icon_owned=0
  for nexus_candidate in "${nexus_icon_candidates[@]}"; do
    if grep -Fxq -- "Icon=$nexus_candidate" "$nexus_desktop"; then nexus_icon_owned=1; break; fi
  done
  if [[ "$nexus_icon_owned" -eq 0 ]]; then
    nexus_icon_line=$(awk 'substr($0,1,5)=="Icon="{print substr($0,6); exit}' "$nexus_desktop") || true
    if [[ -n "$nexus_icon_line" && "$(realpath -ms -- "$nexus_icon_line")" == "$(realpath -ms -- "$nexus_lexical_icon")" ]]; then
      nexus_icon_owned=1
    fi
  fi
  if [[ "$nexus_name_owned" -eq 1 && "$nexus_exec_owned" -eq 1 && "$nexus_icon_owned" -eq 1 ]]; then
    remove_file "$nexus_desktop"
  else warn "application entry not matching this installation: $nexus_desktop"; fi
elif [[ -e "$nexus_desktop" || -L "$nexus_desktop" ]]; then
  warn "application entry not created by the installer: $nexus_desktop"
fi

shopt -s nullglob
for nexus_image in "${nexus_images[@]}"; do
  remove_file "$nexus_image"
  remove_file "$nexus_image.part"
  for nexus_file in "$nexus_image".nexus-backup-* "$nexus_image".nexus-update-*; do
    # Only the UUID filenames written by the updater belong to this installation.
    if [[ "${nexus_file##*/}" =~ ^(Nexus-Launcher|Xodus-Nexus)\.AppImage\.nexus-(backup|update)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
      remove_file "$nexus_file"
    fi
  done
done
remove_file "$nexus_app/icon.png"
if [[ ${#nexus_locks[@]} -gt 0 ]]; then
  for nexus_lock in "${nexus_locks[@]}"; do remove_file "$nexus_lock"; done
fi
if [[ "$nexus_dry_run" -eq 0 ]]; then
  if [[ -d "$nexus_app" ]]; then rmdir -- "$nexus_app" 2>/dev/null || warn "additional files in $nexus_app"; fi
  if [[ -d "$nexus_desktop_dir" ]] && command -v update-desktop-database >/dev/null; then
    update-desktop-database "$nexus_desktop_dir" || true
  fi
fi
if [[ "$nexus_removed" -eq 0 ]]; then printf 'No installer-managed application files found.\n'; fi
printf 'Games, saves, settings, runtimes, wallet credentials and system packages were kept.\n'
