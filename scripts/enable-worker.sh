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
    rm -f -- "$staging/.env" "$staging/image-install"
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

if LC_ALL=C awk -v mode="$mode" -v ends_newline="$ends_newline" -v image_marker="$staging/image-install" '
  BEGIN {
    quote = sprintf("%c", 39)
    bom = sprintf("%c%c%c", 239, 187, 191)
    worker = "docker-compose.worker.yml"
    newline = "\n"
  }
  function invalid(status) { failed = status ? status : 1; exit failed }
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
      if (suffix ~ /^:docker-compose[.]worker[.]yml[ \t]*(#.*)?\r?$/) invalid(43)
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
      if (file == "docker-compose.image.yml" || file == "./docker-compose.image.yml") {
        # Only the parsed selection decides the hint; never evaluate .env.
        print "image" > image_marker
      }
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
    # Refuse even when the BOM precedes another key: otherwise that key cannot be
    # classified reliably and may hide a multiline value or duplicate setting.
    if (NR == 1 && substr(line, 1, 3) == bom) invalid(42)
    if (NR == 1 && line ~ /\r$/) newline = "\r\n"
    if (multiline != "") {
      if (quote_end(line, multiline)) multiline = ""
    } else if (line ~ /^[ \t]*(export[ \t]+)?COMPOSE_FILE[ \t]*=/) {
      if (found++) invalid()
      value = line
      sub(/^[ \t]*(export[ \t]+)?COMPOSE_FILE[ \t]*=/, "", value)
      line = selection(value)
      # Preserve CRLF for the changed assignment as well as unrelated records.
      if ($0 ~ /\r$/) line = line "\r"
    } else if (line ~ /^[ \t]*(export[ \t]+)?[][a-zA-Z0-9_.\200-\377-]+[ \t]*[:=]/) {
      # A key-looking line inside another quoted value is data, not a setting.
      # Compose accepts more than shell identifiers (including ., -, brackets,
      # digit-leading and Unicode names). With LC_ALL=C, preserve non-ASCII key
      # bytes opaquely rather than interpreting them or relying on locale rules.
      key = line
      sub(/^[ \t]*(export[ \t]+)?/, "", key)
      sub(/[ \t]*[:=].*$/, "", key)
      if (key == "COMPOSE_FILE") invalid()
      value = line
      sub(/^[ \t]*(export[ \t]+)?[][a-zA-Z0-9_.\200-\377-]+[ \t]*[:=][ \t]*/, "", value)
      delimiter = substr(value, 1, 1)
      if ((delimiter == quote || delimiter == "\"") && !quote_end(substr(value, 2), delimiter)) multiline = delimiter
    } else if (line !~ /^[ \t]*#/ && line ~ /(^|[^a-zA-Z0-9_])COMPOSE_FILE([^a-zA-Z0-9_]|$)/) {
      # Compose also accepts colon assignments. Never append a second setting
      # when an existing selection uses syntax we cannot safely rewrite.
      invalid()
    }
    if (have_line) printf "%s\n", previous
    previous = line
    have_line = 1
  }
  END {
    if (failed) exit failed
    if (multiline != "") exit 1
    if (have_line) printf "%s", previous
    if (!found) {
      if (have_line) printf "%s", (ends_newline == "true" ? "\n" : newline)
      printf "%s%s", selection("docker-compose.yml"), newline
    } else if (ends_newline == "true") printf "\n"
  }
' "$env_file" > "$staging/.env"; then
  :
else
  case "$?" in
    42) fail 'Remove the leading UTF-8 BOM from .env (save as UTF-8 without BOM), then rerun. No settings were changed.' ;;
    43) fail "Move :docker-compose.worker.yml inside the closing quote in .env: COMPOSE_FILE='docker-compose.yml:docker-compose.worker.yml' (plain), or COMPOSE_FILE='docker-compose.yml:docker-compose.proxy.yml:docker-compose.worker.yml' (bundled HTTPS). Preserve any other existing files, then rerun. No settings were changed." ;;
    *) fail 'COMPOSE_FILE is ambiguous or unsupported; rewrite it as one complete COMPOSE_FILE assignment with = and a quoted, literal colon-separated file list, preserving all existing files. No settings were changed.' ;;
  esac
fi

# Recheck before replacement. Moving into the known parent directory replaces
# the .env entry itself rather than following a link to a directory.
[ ! -L "$env_file" ] || fail 'Refusing to rewrite a symlink at .env.'
[ -f "$env_file" ] || fail '.env changed during the rewrite; no settings were changed.'
chmod 600 "$staging/.env"
mv -f -- "$staging/.env" "$repo/"

build_flag=' --build'
if [ -f "$staging/image-install" ]; then build_flag=; fi
printf '%s\n' 'Updated only COMPOSE_FILE in private .env (mode 600).' 'Run from this checkout:' '  unset COMPOSE_FILE HOURMERE_VERSION'
if [ "$mode" = on ]; then
  printf '%s\n' '  # Bundled HTTPS only; omit this check in plain mode.' '  docker compose config --services | grep -qx proxy &&' '  docker compose config --services | grep -qx worker &&' "    docker compose up -d${build_flag} --wait"
else
  printf '%s\n' '  # Remove any legacy HOURMERE_ROLE=web setting from .env before continuing.' "  docker compose up -d${build_flag} --wait --remove-orphans"
fi
