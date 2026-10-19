#!/bin/sh
# Generate deployment configuration only; starting containers is a separate command.
# Disable inherited tracing before reading or generating any credentials.
set +x
set -eu
umask 077

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=$repo/.env
staging=
terminal_state=

cleanup() {
  if [ -n "$terminal_state" ]; then
    stty "$terminal_state" 2>/dev/null || :
  fi
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

if [ -e "$env_file" ] || [ -L "$env_file" ]; then
  fail '.env already exists; setup never overwrites it. Edit that file instead.'
fi
[ -f "$repo/.env.example" ] || fail 'Run setup from a complete Hourmere checkout.'
for utility in openssl awk mktemp link; do
  command -v "$utility" >/dev/null 2>&1 || fail "Required command is missing: $utility"
done

prompt() {
  printf '%s' "$1" >&2
  IFS= read -r answer || fail 'Setup cancelled before configuration was written.'
}

prompt_secret() {
  printf '%s' "$1" >&2
  if [ -t 0 ]; then
    terminal_state=$(stty -g)
    stty -echo
  fi
  if IFS= read -r answer; then
    read_ok=true
  else
    read_ok=false
  fi
  if [ -n "$terminal_state" ]; then
    stty "$terminal_state"
    terminal_state=
    printf '\n' >&2
  fi
  [ "$read_ok" = true ] || fail 'Setup cancelled before configuration was written.'
}

# DNS labels and numeric ports only; no credentials, path, query, fragment or whitespace.
# Caddy's public path deliberately requires one HTTPS DNS hostname without a port.
valid_origin() {
  printf '%s\n' "$1" | LC_ALL=C awk -v mode="$mode" '
    function hostname(value, labels, count, i) {
      if (length(value) > 253) return 0
      count = split(value, labels, ".")
      for (i = 1; i <= count; i++) {
        if (length(labels[i]) > 63 || labels[i] !~ /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/) return 0
      }
      return count > 0
    }
    {
      if ($0 !~ /^https?:\/\//) exit 1
      authority = $0
      sub(/^https?:\/\//, "", authority)
      if (mode == "proxy") {
        if ($0 !~ /^https:\/\// || !hostname(authority) || authority !~ /[a-zA-Z]/) exit 1
      } else {
        if (authority ~ /^\[::1\](:[0-9]+)?$/) sub(/^\[::1\]/, "localhost", authority)
        count = split(authority, parts, ":")
        if (count > 2 || !hostname(parts[1])) exit 1
        if (count == 2 && (parts[2] !~ /^[0-9]+$/ || parts[2] + 0 < 1 || parts[2] + 0 > 65535)) exit 1
      }
      exit 0
    }'
}

prompt 'Deployment mode [proxy/plain] (proxy): '
mode=${answer:-proxy}
case "$mode" in
  proxy) default_url=https://app.hourmere.com ;;
  plain) default_url=http://localhost:3000 ;;
  *) fail 'Choose proxy or plain.' ;;
esac
prompt "Public origin ($default_url): "
public_url=${answer:-$default_url}
valid_origin "$public_url" || fail 'Use an HTTP(S) origin without a path; proxy mode requires an HTTPS DNS hostname without a port.'

prompt_secret 'SMTP URL (hidden; blank only for a private loopback trial): '
smtp_url=$answer
mail_from=
if [ -n "$smtp_url" ]; then
  # Credentials may contain Compose metacharacters; they are safely quoted below.
  case "$smtp_url" in
    smtp://?*|smtps://?*) ;;
    *) fail 'SMTP URL must start with smtp:// or smtps://.' ;;
  esac
  case "$smtp_url" in
    *[[:space:]]*|*\#*) fail 'SMTP URL must not contain whitespace or a fragment; percent-encode credentials.' ;;
  esac
  prompt 'Mail sender (for example Hourmere <bookings@example.com>): '
  mail_from=$answer
  [ -n "$mail_from" ] || fail 'MAIL_FROM is required with SMTP_URL.'
  case "$mail_from" in
    *[[:cntrl:]]*) fail 'Mail sender must contain only single-line text.' ;;
  esac
else
  case "$mode:$public_url" in
    plain:http://localhost|plain:http://localhost:*|plain:http://127.0.0.1|plain:http://127.0.0.1:*|plain:http://\[::1\]|plain:http://\[::1\]:*) ;;
    *) fail 'Public deployments require SMTP_URL and MAIL_FROM before starting.' ;;
  esac
  printf '%s\n' 'Private trial: sign-in links go to container logs; readers of those logs can sign in.' >&2
  prompt 'Use this private loopback trial without SMTP? Type yes: '
  [ "$answer" = yes ] || fail 'SMTP-free trial was not confirmed; no configuration was written.'
fi

auth_secret=$(openssl rand -base64 32) || fail 'Could not generate the authentication secret.'
postgres_password=$(openssl rand -base64 32) || fail 'Could not generate the database password.'
[ "${#auth_secret}" -eq 44 ] && [ "${#postgres_password}" -eq 44 ] || fail 'Secret generation returned an invalid value.'
case "$auth_secret$postgres_password" in
  *[!a-zA-Z0-9+/=]*) fail 'Secret generation returned an invalid value.' ;;
esac
[ "$auth_secret" != "$postgres_password" ] || fail 'Secret generation did not produce independent values.'

# Compose single quotes disable interpolation (including $, # and spaces). Escaped
# apostrophes are supported by Compose; do not source this file as a shell script.
write_setting() {
  printf "%s='" "$1"
  value=$2
  while :; do
    case "$value" in
      *\'*)
        printf '%s%s' "${value%%\'*}" "\\'"
        value=${value#*\'}
        ;;
      *) break ;;
    esac
  done
  printf "%s'\n" "$value"
}

staging=$(mktemp -d "$repo/.env.setup.XXXXXXXX")
{
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      BETTER_AUTH_SECRET=*|POSTGRES_PASSWORD=*|PUBLIC_URL=*|SMTP_URL=*|MAIL_FROM=*|SIGNUP=*|AUTO_MIGRATE=*|COMPOSE_FILE=*) continue ;;
    esac
    printf '%s\n' "$line"
  done < "$repo/.env.example"
  printf '\n# Generated by scripts/setup.sh. Keep this file private and backed up.\n'
  write_setting BETTER_AUTH_SECRET "$auth_secret"
  write_setting POSTGRES_PASSWORD "$postgres_password"
  write_setting PUBLIC_URL "$public_url"
  write_setting SMTP_URL "$smtp_url"
  write_setting MAIL_FROM "$mail_from"
  write_setting SIGNUP first-user
  write_setting AUTO_MIGRATE true
  if [ "$mode" = proxy ]; then
    write_setting COMPOSE_FILE docker-compose.yml:docker-compose.proxy.yml
  else
    write_setting COMPOSE_FILE docker-compose.yml
  fi
} > "$staging/.env"

# POSIX link creates exactly this path atomically and fails for every existing object,
# including dangling symlinks and directories. Unlike ln, it never follows a target
# directory. The temporary file is on the same filesystem and already has mode 0600.
link "$staging/.env" "$env_file" 2>/dev/null || fail 'Could not create .env; it may already exist. No existing file was changed.'
printf '%s\n' 'Created private .env (mode 600). Back it up securely.' 'Start Hourmere: docker compose up -d --build --wait'
