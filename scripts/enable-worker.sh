#!/bin/sh
# Change deployment configuration only; the printed commands recreate containers.
# Never trace credentials while reading .env, even when invoked with sh -x.
set +x
set -eu
umask 077

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=$repo/.env
staging=

cleanup() {
  if [ -n "$staging" ]; then
    rm -f -- "$staging/.env"
    rmdir -- "$staging"
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$#" -le 1 ] || fail 'Usage: scripts/enable-worker.sh [on|off]'
mode=${1:-on}
case "$mode" in
  on|off) ;;
  *) fail 'Usage: scripts/enable-worker.sh [on|off]' ;;
esac

[ ! -L "$env_file" ] || fail 'Refusing to rewrite a symlink at .env.'
[ -f "$env_file" ] || fail 'A regular .env is required; run scripts/setup.sh first.'
for utility in awk mktemp tail; do
  command -v "$utility" >/dev/null 2>&1 || fail "Required command is missing: $utility"
done

staging=$(mktemp -d "$repo/.env.worker.XXXXXXXX")
# awk normally adds a newline to the last record. Preserve an unterminated final
# line too, so every byte outside the COMPOSE_FILE assignment stays unchanged.
ends_newline=false
if [ -s "$env_file" ] && [ -z "$(tail -c 1 "$env_file")" ]; then
  ends_newline=true
fi

LC_ALL=C awk -v mode="$mode" -v ends_newline="$ends_newline" '
  BEGIN { quote = sprintf("%c", 39); worker = "docker-compose.worker.yml" }
  function invalid() { failed = 1; exit 1 }
  function quote_end(value, delimiter,    i, character, escaped) {
    for (i = 1; i <= length(value); i++) {
      character = substr(value, i, 1)
      if (escaped) { escaped = 0; continue }
      if (character == "\\") { escaped = 1; continue }
      if (character == delimiter) return i
    }
    return 0
  }
  function selection(value,    delimiter, close_at, suffix, count, files, i, selected, has_worker, file) {
    sub(/^[ \t]*/, "", value)
    delimiter = substr(value, 1, 1)
    if (delimiter == quote || delimiter == "\"") {
      value = substr(value, 2)
      close_at = index(value, delimiter)
      if (!close_at) invalid()
      suffix = substr(value, close_at + 1)
      if (suffix !~ /^[ \t]*(#.*)?\r?$/) invalid()
      value = substr(value, 1, close_at - 1)
    } else {
      sub(/[ \t]+#.*/, "", value)
      sub(/[ \t\r]*$/, "", value)
    }
    # Compose paths are literal here. Reject interpolation, escapes, malformed
    # quoting and multiline values instead of evaluating or guessing at them.
    if (value == "") value = "docker-compose.yml"
    count = split(value, files, ":")
    selected = ""
    has_worker = 0
    for (i = 1; i <= count; i++) {
      if (files[i] !~ /^[a-zA-Z0-9_.\/@+-]+$/) invalid()
      file = files[i]
      if (file == worker || file == "./" worker) {
        if (mode == "off" || has_worker) continue
        file = worker
        has_worker = 1
      }
      selected = selected (selected == "" ? "" : ":") file
    }
    if (selected == "") selected = "docker-compose.yml"
    if (mode == "on" && !has_worker) selected = selected ":" worker
    return "COMPOSE_FILE=" quote selected quote
  }
  {
    line = $0
    if (multiline != "") {
      if (quote_end(line, multiline)) multiline = ""
    } else if (line ~ /^[ \t]*(export[ \t]+)?COMPOSE_FILE[ \t]*=/) {
      if (found++) invalid()
      value = line
      sub(/^[ \t]*(export[ \t]+)?COMPOSE_FILE[ \t]*=/, "", value)
      line = selection(value)
      # Preserve CRLF for the changed assignment as well as unrelated records.
      if ($0 ~ /\r$/) line = line "\r"
    } else if (line ~ /^[ \t]*(export[ \t]+)?[a-zA-Z_][a-zA-Z0-9_]*[ \t]*=/) {
      # A key-looking line inside another quoted value is data, not a setting.
      value = line
      sub(/^[ \t]*(export[ \t]+)?[a-zA-Z_][a-zA-Z0-9_]*[ \t]*=[ \t]*/, "", value)
      delimiter = substr(value, 1, 1)
      if ((delimiter == quote || delimiter == "\"") && !quote_end(substr(value, 2), delimiter)) multiline = delimiter
    }
    if (have_line) printf "%s\n", previous
    previous = line
    have_line = 1
  }
  END {
    if (failed || multiline != "") exit 1
    if (have_line) printf "%s", previous
    if (!found) {
      if (have_line) printf "\n"
      printf "%s\n", selection("docker-compose.yml")
    } else if (ends_newline == "true") printf "\n"
  }
' "$env_file" > "$staging/.env" || fail 'COMPOSE_FILE is ambiguous or unsupported; use one complete quoted, literal colon-separated file list. No settings were changed.'

# Recheck before replacement. Moving into the known parent directory replaces
# the .env entry itself rather than following a link to a directory.
[ ! -L "$env_file" ] || fail 'Refusing to rewrite a symlink at .env.'
[ -f "$env_file" ] || fail '.env changed during the rewrite; no settings were changed.'
chmod 600 "$staging/.env"
mv -f -- "$staging/.env" "$repo/"

printf '%s\n' 'Updated only COMPOSE_FILE in private .env (mode 600).' 'Run from this checkout:' '  unset COMPOSE_FILE'
if [ "$mode" = on ]; then
  printf '%s\n' '  docker compose config --services | grep -qx worker &&' '    docker compose up -d --build --wait'
else
  printf '%s\n' '  # Remove any legacy HOURMERE_ROLE=web setting from .env before continuing.' '  docker compose up -d --build --wait --remove-orphans'
fi
