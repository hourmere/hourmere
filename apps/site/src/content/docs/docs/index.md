---
title: Documentation
description: Run Hourmere yourself and connect booking clients through REST or MCP.
---

Hourmere is in early development. These guides describe the current source tree; there is
no stable release yet; the open-source release is planned for **2026-11-30**. Hourmere Cloud
is an [invitation-only preview](/#faq) with sign-ups closed.
The website at hourmere.com is separate from your Hourmere instance.

- [Self-host with Docker Compose](/docs/self-hosting): install, configure email and a proxy,
  split workers, back up and upgrade.
- [Cal.com / cal.diy import](/docs/calcom-import): preview and apply local-only busy records,
  inspect limits and overlaps, and recover an incomplete selection.
- [Install the app](/docs/install-app): add Hourmere to your home screen and understand
  its offline notice and privacy boundaries.
- [Configuration reference](/docs/configuration): environment variables and Compose behavior.
- [Troubleshooting](/docs/troubleshooting): email delivery, workers, HTTPS, DNS and database
  startup failures.
- [Compare scheduling options](/docs/comparison): deployment, agent access and the current
  limitations of Hourmere alongside Calendly, Cal.com and Cal.diy.
- [Availability and working hours](/docs/availability): copy hours between days and save
  weekly hours and date overrides together.
- [Multiple meeting lengths](/docs/multiple-durations): configure the offered lengths and
  default, and learn how invitees choose and reschedule.
- [Booking limits](/docs/booking-limits): set daily, weekly and monthly allowances in
  the editor, REST, MCP or CLI.
- [Reschedule and cancel deadlines](/docs/change-deadlines): stop invitees from moving or
  cancelling through their link shortly before the start; hosts are not limited.
- [After-booking redirects](/docs/after-booking): offer a Continue link with explicit
  parameter, privacy and embed permissions.
- [One-time booking links](/docs/one-time-links): create, list and revoke private links
  through the editor, REST, MCP or CLI, with the booking URL shown once.
- [Reminders and follow-ups](/docs/reminders-and-follow-ups): choose email times, recipients
  and optional host notes, with delivery limits and configuration examples.
- [Troubleshoot availability](/docs/availability-troubleshooting): see why a time cannot be
  booked, from the admin, REST, MCP or CLI.
- [Open-time snippets for agents](/docs/open-time-snippets): draft an email with current
  alternatives and direct booking links through REST, MCP or CLI.
- [REST quickstart](/docs/rest): create an API key and find, book and manage a time slot.
- [CSV booking export](/docs/booking-export): download a bounded date range for reporting,
  with personal-owner and team-administrator permissions.
- [MCP quickstart](/docs/mcp): connect a client with an API key and use the booking tools.
- [Google Calendar](/docs/google-calendar): configure separate calendar authorization and
  choose busy-time calendars and a booking destination.
- [Microsoft Calendar](/docs/microsoft-calendar): register an Entra application and connect,
  refresh or disconnect an Outlook calendar list. Busy-time sync and event writes are pending.

- [Marking no-shows](/docs/no-shows): record private attendance per invitee or guest.
- [Booking waitlists](/docs/booking-waitlist): let invitees confirm an empty period and
  receive notification when a matching time opens; manage entries in the editor, REST,
  MCP or CLI. Available in full to self-hosters.

## Create an event type

Open **Event types**, then **New event type** in your Hourmere instance. Start with four
things: **Title**, **Booking link**, **Duration (minutes)** and **Where the meeting happens**. The link follows your title and
meeting length until you edit it yourself. Choose a 15, 30, 45 or 60-minute duration
preset, or enter a custom whole-minute duration. A location can be left unset; phone, address
and meeting-link choices ask for the details needed for that choice.

The other settings are grouped in closed disclosures. Open a group to configure
availability, booking limits, notice and buffers, multiple meeting lengths, additional
locations, hosts, questions, guests, notifications, waitlists or the after-booking redirect.
You can create immediately using the existing defaults, then adjust these settings later.
A team event initially selects you as its host. Availability still depends on the host's
configured working hours; creating an event does not create a schedule.

When editing, groups with saved non-default values open automatically so you can review
them. Closing a group keeps its values. A validation error in a closed group opens that
group and moves focus to the affected field. Saving a title change preserves other saved
configuration, including settings configured through REST, MCP or CLI.

### Notice, booking window and buffers

In the notice and buffer settings, choose **Minutes**, **Hours** or **Days** for minimum
notice, the booking window, and the buffers before and after a meeting. On opening an
event, a minute-based value uses the largest unit that expresses it as a whole number:
1440 minutes becomes 1 day, 120 minutes becomes 2 hours, and 90 minutes stays 90 minutes.
Zero stays in minutes. A saved booking window opens in days; an empty window has no limit.

Changing only the unit changes the display, not the saved value, and does not mark the
form as changed. Saving an unchanged editor sends no update. Saving another field omits
untouched timing settings, so a timing setting
changed concurrently through the API is preserved. The selected display unit is not saved.

| Setting | Stored unit and inclusive range |
|---|---|
| Default duration | 1–1440 whole minutes |
| Minimum notice | 0–525600 whole minutes |
| Buffer before / after | 0–1440 whole minutes each |
| Booking window | 1–3650 whole days, or empty for no limit |

Unit conversion uses 60 minutes per hour and 24 hours per day. The booking window still
counts calendar days in the host's schedule time zone, including across daylight saving
time changes; its hour/minute display does not turn it into an elapsed-time window.
Decimal input is accepted only when it resolves exactly to whole stored minutes, or
whole stored days for the booking window: for example, 1.5 hours is 90 minutes. Switching
a value such as 1 minute to hours may display a rounded decimal, while its exact stored
value remains unchanged until you edit it.
Fractional-day booking windows and sub-minute notice or buffers are not supported.
Validation uses these stored ranges and shows the permitted range in your selected unit.
See [multiple meeting lengths](/docs/multiple-durations) to offer more than one duration.

After saving, use **View and share** to open or copy the saved booking link. Round-robin
pools still require explicit activation. These form changes are included in self-hosting;
REST, MCP and CLI defaults and permissions are unchanged. Group seats and paid-booking
configuration remain unavailable in the editor, as described below.

## Review bookings

In **Bookings**, select an event title to open its detail. On wide screens the detail
slides in from the right over the list; on phones it replaces the list as an ordinary page,
with the app navigation still available. **Team bookings**
uses the same view for owners and admins, with its existing limited team information
and actions. Close the detail to return to your view, search, loaded pages and scroll
position. Attendance and booking changes made there update the retained list.

Use **Previous booking** and **Next booking** to follow the current filtered list order.
The next page loads when needed; controls are unavailable at the ends. Opening adds one
browser history entry, and stepping replaces that entry, so browser Back returns to the
list. Copy the detail URL to open it later: a direct visit or reload shows the ordinary
full detail page without a background list or previous/next controls.

The desktop detail is a modal dialog: focus moves inside when opened, and Tab and
Shift+Tab stay within its controls. The list stays visible behind it, but cannot receive
keyboard or pointer input until the detail closes; this keeps covered controls out of
the keyboard path. Closing returns focus to the original row. Escape closes the detail when a nested form or text field is not using that key;
there are no arrow-key shortcuts. The slide respects reduced-motion preferences.

List position is kept only during the current in-app visit, not after a reload. Results
are loaded with the current filters rather than a fixed server snapshot, so concurrent
changes can affect later pages. Team bookings has date/status/order filters but no text
search. Team detail keeps the loaded list snapshot until a list refresh; a fresh access
check still runs when selecting a booking, and writes recheck its current state.
Direct links retain all existing access checks; unavailable bookings show the
usual error without discarding the retained list. This interface is included in
self-hosting and does not change REST, MCP or CLI operations.

## Known limitations

- Event-type timing units are a web display preference and are not persisted. Notice and
  buffers require whole minutes; booking windows require whole calendar days, even when
  shown in hours or minutes. REST, MCP and CLI retain their existing units.
- [Audit events](/docs/audit-log) are recorded only for the management changes listed
  there. Owners and admins can read and filter them; export is not available yet.
- Prebuilt image installs have no runtime switch to disable app installation or the
  offline shell. Changing `VITE_PWA_ENABLED` requires rebuilding from source and replacing
  the deployed image; see [conversion steps](/docs/self-hosting#turn-off-app-installation).
- [SCIM](/docs/scim) provides provisioning-token administration only; creation/rotation is disabled by default.
  Users, Groups, discovery and IdP synchronization are not available yet.
- Organization OIDC/SAML SSO is in design and is not available yet. The
  [SSO design](https://github.com/hourmere/hourmere/blob/main/docs/sso.md) covers
  self-hosting, linking, enforcement and the planned implementation sequence.
  Planned SSO is available to every instance without a paid-plan requirement.
- [Make](/docs/make) recipes require manual assembly; no import-verified blueprint or native
  Hourmere Make app is shipped. Verify signed webhooks before any downstream action.
- The [n8n community node](/docs/n8n) is not yet published to npm or available on n8n Cloud.
  Self-hosters can install its local package; downstream effects need durable idempotency.
- [Zapier](/docs/zapier) is not yet published in the Zapier directory. The source app
  can be deployed privately with your own Zapier account.
- Booking workflows are [design only](https://github.com/hourmere/hourmere/blob/main/docs/workflows.md).
  Conditional email and webhook actions are not available yet, including for self-hosters.
  During implementation, generated API-key/MCP scope tables, OpenAPI and CLI help may list
  operations before enablement; those entries will document their disabled behavior.
  Docker Compose may also forward workflow settings that have no effect until then.
  Existing reminders, follow-ups and signed booking webhooks keep their current behavior.
- [Cal.com imports](/docs/calcom-import#known-limitations) create inactive drafts and read-only
  local busy records. Same-owner incremental completion is unavailable; group-slot overlaps
  block the batch, while daily/weekly/monthly limit differences are reported as warnings.
- [Slack notifications](/docs/slack) support one incoming-webhook destination per organization,
  minimal booking data and at-least-once delivery; duplicate messages are possible.
- [Booking limits](/docs/booking-limits) apply per event type and actual host, across
  all meeting lengths. Organization-wide quotas and rolling windows are unavailable.
  Lowering a limit does not cancel existing bookings.
- [Reschedule and cancel deadlines](/docs/change-deadlines#known-limitations) are whole
  minutes before the start and are not yet stated in emails. Changing them never updates
  existing bookings.
- [Availability drafts](/docs/availability#known-limitations) have no autosave or automatic
  conflict merge; use the combined API for atomic edits with version checks. Schedules
  allow at most 10,000 date overrides, including past dates.
- [Booking waitlists](/docs/booking-waitlist#known-limitations) support one-on-one
  single-host types at the default meeting length. Nothing is reserved; the first
  successful ordinary booking wins, and email delivery is not guaranteed.
- CalDAV (including iCloud, Fastmail and Nextcloud) is not available to connect yet.
  The [design and internal connection foundation](https://github.com/hourmere/hourmere/blob/main/docs/caldav.md)
  adds no busy-time sync, event writes or UI/API/MCP/CLI access. Real-account acceptance
  is still pending; see the [operator note](/docs/self-hosting#caldav-foundation).
- [Paid bookings](/docs/payments) have an internal hold foundation only. Checkout, Stripe
  processing, payment settings and automatic refunds are not available.
- [Requests to choose another time](/docs/request-reschedule) retain the original booking
  until it is moved or cancelled. Expiry keeps it confirmed; imported and group-seat
  bookings do not support requests.
- [Branding settings](/docs/branding) store a logo and primary colour per space; public
  booking pages and emails do not apply them yet.
- [CSV exports](/docs/booking-export) require a range of at most 366 elapsed days and
  permit one active export per organization. Each process also permits one export per
  user and two exports total by default (`export_user_in_progress` / `export_busy`);
  these concurrency limits are per process, not cluster-wide. Files contain personal data; there is no
  scheduled export or automatic delivery. Answers use a JSON column.
- Group mode cannot yet be enabled in event editors or REST/MCP/CLI configuration;
  this limitation applies equally to self-hosted installations. For internally seeded group
  types, public booking pages and inline, popup and manual iframe embeds show exact seats
  remaining beside each offered time. Full occurrences are omitted. The public slots API
  adds `seatsRemaining` and `capacity` only for group times; these are aggregate totals,
  with no attendee names, addresses or seat identities. Counts are a snapshot, not a
  reservation. If another visitor takes the last seat, the page asks you to choose another
  time and keeps your form entries. Cancellation or moving a seat releases its place; a
  refreshed availability request shows it again if admission is still allowed.
  When the existing waitlist is enabled, an empty selected window uses that same waitlist;
  a window with free seats does not offer enrollment. No seat is reserved by joining it.
  The invitee reschedule picker still lists new available occurrences only; it does not
  display remaining seats or offer other already occupied group occurrences. Moving or
  canceling a seat nevertheless updates the counts on the public booking page.
  Existing occurrences retain
  their shared location, schedule and conference settings when event settings change, and
  continue accepting seats until full, subject to current booking cutoffs and usable pinned
  conference resources. Later time off, external-calendar conflicts and stale calendar sync
  do not block additional seats or moves into an existing occurrence; the host must cancel
  it to stop admission. New occurrences check current time off, calendar conflicts and sync
  freshness as well as the edited settings. A full occurrence gives
  the same error for existing and unknown email addresses; exact request replays still work.
  With spare capacity, duplicate-email rejection does not guarantee membership privacy:
  a different email address can create a real seat and its notifications. Every refusal
  that does not create a seat (mismatched location options, cutoffs, an unusable pinned
  Zoom or Google Meet resource) returns the same error whether or not the email address
  already holds a seat.
  Host occurrence mail drains batches of four for up to 230 seconds per worker run;
  remaining due messages stay durable for the next run, subject to reminder expiry,
  the instance email abuse budget and delivery retries.
- Public booking and sign-in pages have no CAPTCHA; invitee/guest email addresses remain
  unverified. [Email abuse limits](/docs/notifications#email-abuse-controls) apply per
  instance/database; separate instances do not share budgets. Per-IP request limits remain
  in process memory, except the additional durable booking-waitlist admission limits.
- [Microsoft Calendar](/docs/microsoft-calendar) lists calendars only, without busy-time
  synchronization or event writes. [Microsoft sign-in](/docs/configuration#sign-in-with-microsoft)
  and calendar connections have not had real-account acceptance.
- [Automatic Zoom](/docs/automatic-zoom)
  supports personal event types and individual team event types with one actual host;
  collective and round-robin event types are unsupported.
- [Meeting location choices](/docs/location-choices) support up to five distinct kinds
  in the editor, REST, MCP and CLI. Rescheduling preserves the original choice.
- [Multiple meeting lengths](/docs/multiple-durations) share one set of hosts, location
  and booking rules; per-length overrides are unavailable. Web rescheduling keeps the
  original length; changing it requires REST, MCP or CLI.
- [Calendar RSVP replies](/docs/notifications#email-headers-mime-and-replies)
  are not processed; declining in a calendar does not cancel an Hourmere booking. Use
  Hourmere's cancellation action; operators must [handle replies manually](/docs/self-hosting#handle-calendar-replies).
- [Follow-ups](/docs/reminders-and-follow-ups) use the scheduled end regardless of
  attendance. Invitees cannot stop them after the meeting starts; cancel in Hourmere
  before the start. Mail limits can permanently suppress a message.
- [No-show marks](/docs/no-shows) are manual and private. They do not suppress follow-ups.
  [Booking activity](/docs/analytics) counts current marks per day; per-host breakdowns,
  rates and attendance exports are not yet available.
- PostgreSQL 18+ is required for `uuidv7()`; [PgBouncer is unsupported](/docs/configuration#server-and-database).
  The [upgrade notes](https://github.com/hourmere/hourmere/blob/main/CHANGELOG.md#upgrade-notes)
  cover the database version requirement.
- Hourmere must be served at the root of its own host name (no path prefix) in every deployment.
  [Bundled Caddy](/docs/self-hosting#prepare-the-host) additionally requires ports 80/443,
  an HTTPS host name without a port, and an IPv4-only ingress network.
- [Rate limiting](https://github.com/hourmere/hourmere/blob/main/apps/server/src/rate-limit.ts)
  uses in-process memory at the transport layer; multiple web replicas multiply the limits.
  Waitlists additionally enforce durable mailbox, event and trusted-IP admission budgets. Run a single web process;
  a [separate worker](/docs/self-hosting#run-workers-separately) is supported.
- [Public booking pages and emails](/docs/interface-languages) support English,
  Simplified Chinese, German, French, Spanish and Brazilian Portuguese. Account and sign-in interfaces support English and
  Simplified Chinese. Missing translations fall back to English;
  dates use the active language with the existing time-zone rules.
- [Schema downgrade is not automatic](/docs/self-hosting#upgrade-and-roll-back). Some
  migrations are not rolling-upgrade safe: stop all old app and worker processes as required
  by the [migration notes](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#changing-the-schema)
  and [calendar-email upgrade notes](/docs/notifications#identity-and-recipients).

## More guides

Explore these detailed guides:

- [CLI](/docs/cli): use the booking tools
  from a terminal with an API key.
- [Booking webhooks](/docs/webhooks):
  configure signed delivery and retries.
- [Make](/docs/make): connect booking webhooks to Sheets or Slack, or create bookings with HTTP.
- [n8n](/docs/n8n): automate bookings with actions and signed triggers in self-hosted n8n.
- [Zapier](/docs/zapier): connect booking triggers, actions and searches through a
  private integration.
- Team scheduling: [collective meetings](/docs/collective-scheduling)
  and [round-robin pools](/docs/round-robin-scheduling).
- [Automatic Google Meet](/docs/automatic-google-meet)
  and [automatic Zoom](/docs/automatic-zoom):
  configure explicit meeting creation and recovery.
- [Notifications and background jobs](/docs/notifications):
  understand delivery, retries and calendar invitations.

The software is licensed under AGPL-3.0. File bugs and feature ideas in
[GitHub Issues](https://github.com/hourmere/hourmere/issues). Report vulnerabilities privately
to [security@hourmere.com](mailto:security@hourmere.com) or through the repository's
[Security tab](https://github.com/hourmere/hourmere/security/advisories/new).
