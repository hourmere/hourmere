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
only changes the draft until the main save succeeds.

The server commits everything in one database transaction. If any part fails,
none of the changes are saved and your draft remains available to correct or retry.
A saved confirmation means both the week and the overrides were saved.

If another tab or client changes the schedule after you opened it, saving reports
a conflict instead of replacing that newer state. Keep a separate note of your
intended changes, reload the latest schedule, then reapply them. Leaving a dirty
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
- Combined REST saves accept up to 2 MiB of JSON; MCP and CLI also retain their
  transport limits. Exceptionally large override lists can exceed these limits.
- Hours use the schedule's IANA time zone and the existing daylight-saving rules.
  Saving hours does not move or cancel existing bookings.
