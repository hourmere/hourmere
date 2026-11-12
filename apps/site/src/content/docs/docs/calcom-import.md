---
title: Cal.com / cal.diy import
description: Preview local busy-record imports, understand limit and overlap warnings, and handle incomplete selections.
---

The local operator CLI imports supported Cal.com and cal.diy snapshots into existing,
consenting Hourmere accounts. It is available in full to self-hosters. Follow the
[operator setup and commands](https://github.com/hourmere/hourmere/blob/main/docs/calcom-import.md)
for supported versions, dedicated read-only source permissions, protected connection files,
owner consent, source registration and preview/apply commands.

The preview command writes no business or import-metadata rows. Review the private plan,
freeze source changes during cutover, and apply that exact plan. All selected users commit
in one atomic target transaction. Imported events remain inactive drafts; bookings remain
local-only, read-only busy records managed in the original system. The import sends no mail,
ICS, calendar copies, conference requests or webhooks. Authorized REST, MCP and CLI booking
readers expose imported records and their management policy; preview/apply itself uses the
local operator CLI.

## Review limits and overlaps

Preview reports daily, weekly and monthly booking-limit impacts per event type and host,
using the host schedule time zone. Weeks start Monday; months follow calendar boundaries,
including daylight-saving changes. Bookings on unrelated event types do not consume that
event's allowance. Imported historical times remain busy even when they exceed a ceiling
or differ from current hours or buffers; the limit impacts explain what apply preserves.

An actual overlap with a target booking or a host's group slot blocks the selected batch.
Group-slot occupancy is included in the target fingerprint, so changes after preview require
reviewing a fresh plan. An import never takes a seat in an existing group slot.

## Complete an incomplete selection

A lost-response retry of a complete unchanged batch returns `IMPORT_NOOP`. Retry the
original plan and protected configuration first. `IMPORT_PARTIAL_MAPPING` means the current
selection mixes already mapped entities and new ones: that attempt commits nothing.

1. Keep the original source namespace and retain the protected plans and reports. Create a
   fresh preview to identify mapped, new and conflicted entities.
2. For owners who have never been imported, use a separate selection with their consent and
   decisions, preview it under the same source namespace, review it, then apply.
3. For additional data belonging to an already imported owner, automatic completion is
   unavailable. Restore a verified whole-target pre-import backup only after assessing all
   subsequent target changes, following [backup and restore](/docs/self-hosting#back-up-and-restore).
   Re-register the source only if the restored backup predates registration. Preview the
   complete intended selection again before applying.
4. If restoring is unsuitable, retain the successful import and manage remaining bookings
   in the original system pending a separately reviewed reconciliation procedure. Never
   delete mappings/tombstones or create another namespace to bypass the refusal.

See the [full recovery steps](https://github.com/hourmere/hourmere/blob/main/docs/calcom-import.md#complete-or-recover-a-partial-import)
for cutover and original-plan replay details.

## Known limitations

There is no import web UI or automatic same-owner incremental import. Team, organization,
managed/multiple-host, payment and instant-event imports are excluded or blocked. Source
changes require a new difference preview; they do not reschedule or cancel local records.
Imported bookings cannot be moved, cancelled or repaired through normal booking actions.
Reconnect calendars and conferences separately and review each draft before activation.
The operator guide documents bounded selections, privacy requirements and safe refusal codes.
