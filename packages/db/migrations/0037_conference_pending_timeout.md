# Migration 0037 upgrade

Column-drop upgrade: Stop every old app and worker process before applying this migration.

This is the first column drop: `booking_conferences.retry_conference` was write-only,
but older web, all and worker processes still write it. Stop workers in this Compose
project and any workers managed elsewhere before starting the upgraded app or running
migrations manually. Restart every role with the upgraded code. Recreating a single
app container with `docker compose up -d --build` already stops that old app first;
it does not stop separate workers before the new app migrates.

This historical migration predates the two-phase retirement policy. Future column drops
must stop writing the column in release N and drop it in N+1. Their matching `.md` note
must identify the release that retired the writes and the required process shutdown.
Do not edit this already-published SQL migration to add the note: its checksum is fixed.
