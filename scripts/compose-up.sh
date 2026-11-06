#!/bin/sh
# Recompute the proxy's file identity on every start, including in-place edits.
set +x
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

# Do not reuse an exported or persisted digest: it may describe another revision.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum < Caddyfile)
else
  digest=$(shasum -a 256 < Caddyfile)
fi
CADDYFILE_SHA256=${digest%% *}
case "$CADDYFILE_SHA256" in
  ''|*[!0-9a-f]*) echo 'Could not hash Caddyfile.' >&2; exit 1 ;;
esac
[ "${#CADDYFILE_SHA256}" -eq 64 ] || { echo 'Could not hash Caddyfile.' >&2; exit 1; }
export CADDYFILE_SHA256

# Preserve Compose's .env selection, project identity, arguments and exit status.
exec docker compose up "$@"
