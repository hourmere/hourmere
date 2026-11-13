---
title: Availability and working hours
description: Copy weekly hours, set date exceptions and save a schedule in one action.
---

Open **Availability** in your account, then edit a schedule. Schedules belong to you
and follow you across personal and team spaces. The default schedule is used unless
an event type selects another one. This feature is included in self-hosted Hourmere.

## Copy hours to other weekdays

Choose **Copy to…** beside a weekday, select the destination days, then apply.
**Weekdays** selects Monday through Friday; **All days** selects every other day.
The source day is never a destination. Copying replaces each selected day's hours,
including existing ranges; it does not merge them. Copying an unavailable or empty
day clears the destination's hours. Later edits to one day do not change the others.

Use Tab to move through the dialog and Space to toggle a checkbox. Escape closes
without applying. Copied hours are still a draft until you save.

An end time of **00:00** means midnight at the end of that day (stored as `24:00`).
Overlapping ranges cannot be saved. For hours crossing midnight, enter one range
ending at midnight and another on the next day.

## Save weekly hours and date overrides together

**Save changes** saves the schedule name, time zone, weekly hours and all date
overrides in one action. Add a date override to replace the usual hours for that
local date; an unavailable override blocks the whole date. Removing an override
restores the weekly hours for that date. Adding, editing and removing overrides
only changes the draft until the main save succeeds. Upcoming rows follow their saved
dates, so editing a date does not move its row. New rows stay in insertion order at
the top until you save; a successful save sorts the rows by their saved dates again.
Past overrides are collapsed and read-only, and are preserved unchanged when saving.
Dates, including time-field accessible names, follow your interface locale. Hours use
the readable time-zone label shown in the section; partial time-zone searches keep
the last valid selection until you choose another zone.

The server commits everything in one database transaction. If any part fails,
none of the changes are saved and your draft remains available to correct or retry.
A saved confirmation means both the week and the overrides were saved.

If another tab or client changes the schedule after you opened it, saving reports
a conflict instead of replacing that newer state. Your draft stays in the editor.
Choose **Review latest version** to compare the saved snapshot with your draft, then
explicitly reapply your draft after reviewing the differences. Focus moves to a
confirmation reminding you that the draft still needs saving. Save changes to submit
it against the reviewed version; another intervening change will conflict again. Leaving a dirty
editor through a link, browser history, reload or closing the tab asks before
abandoning changes. Reverting to the saved values removes that warning.

## REST, MCP and CLI

Read one consistent snapshot with `GET /api/v1/schedules/{id}/availability`.
The response contains `schedule`, `overrides` and an opaque `version`. Send
`PUT /api/v1/schedules/{id}/availability` with `name`, `timeZone`, `weeklyHours`,
`overrides` and `expectedVersion` set to that version. `isDefault` is optional.
The overrides array is a complete replacement; `[]` removes every override.
Each override is `{ "date": "2030-12-24", "intervals": [] }` or contains
`start`/`end` local-time ranges. The response is a fresh snapshot and version.

MCP provides `get_schedule_availability` and `save_schedule_availability` with the
same fields, plus `id`. The CLI exposes `schedule-availability` and
`save-availability`; use their `--help` output for arguments and JSON input.
Read access requires a `read` or `full` API key; saving requires `full`.
The schedule must belong to the caller regardless of interface or key scope.

HTTP 409 `schedule_conflict` means the expected version is stale. A replay of a
successful save also conflicts: after a lost response, read the latest snapshot
and compare it with your intended values before deciding whether to save again.
Do not retry with a fresh version without reviewing the newer state.

## Known limitations

- Drafts are kept only in the current page, with no autosave, offline persistence
  or automatic conflict merge. Browser unload prompts depend on browser support
  and prior interaction; they cannot guarantee recovery after a crash.
- Copying works within one schedule's week; it does not copy date overrides or
  between schedules. Create a schedule before adding date overrides.
- The existing separate schedule and override endpoints remain available for
  compatibility. They do not combine multiple requests into one transaction or
  require an expected version. Their changes invalidate a combined-save snapshot;
  clients needing atomic editing and conflict protection must use the combined API.
- Combined saves accept at most 10,000 overrides, including past dates. More returns
  HTTP 400 `too_many_overrides` (the same error code in MCP/CLI), before any database work.
  The single-date REST endpoint enforces the same limit when adding a date; existing
  dates can still be replaced or removed at the limit, including on older schedules
  that already exceed it. Concurrent additions cannot exceed the limit.
  REST accepts up to 2 MiB of JSON; larger bodies return HTTP 413 `payload_too_large`
  before saving. MCP and CLI also retain their transport limits.
- Hours use the schedule's IANA time zone and the existing daylight-saving rules.
  Saving hours does not move or cancel existing bookings.
