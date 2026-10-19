#!/bin/sh
set +x
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 0 ] || { printf '%s\n' 'Usage: scripts/disable-worker.sh' >&2; exit 1; }
exec "$repo/scripts/enable-worker.sh" off
