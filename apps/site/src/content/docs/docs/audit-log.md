---
title: Audit log
description: Management events recorded for every Hourmere instance.
---

Hourmere records audit events for sign-in session and sign-in method, team creation and
settings, membership, API-key, [SCIM provisioning token](/docs/scim), OAuth, booking
management, [no-show mark](/docs/no-shows), webhook, [Slack destination](/docs/slack),
event-type and branding changes on every self-hosted and Cloud instance.
There is no enterprise-plan requirement. Only those changes are recorded: personal profile
edits (such as your display name), schedules, one-time links, waitlist entries and
calendar connections are not.

Owners and admins can read the audit log of their team, and the owner of a personal space
can read its own, on the **Audit log** page, through the REST API, MCP and the CLI. Owners
choose how long it is kept.

Events identify the organization, time, actor, credential used, action, target and
request. Same-organization agent actions retain the API-key ID and scope, and OAuth
actions retain the client and grant IDs. A booking made with another organization's API
key or OAuth connection records an external actor, without that caller's key, user,
client or grant IDs; so does an invitee declining a team invitation, without their user
or session IDs. Events and the recorded change share a database transaction:
if the event cannot be written, the change fails too.

The journal does not copy secrets, tokens, passwords, raw emails, invitee answers,
attendee names or email addresses, logo images, colours, IP addresses or user agents.
Public invitee actions retain entity IDs only. A no-show change keeps the attendee ID and
whether it marked or unmarked them; a Slack destination change keeps its subscribed events,
never its URL; a provisioning token change keeps the token ID, never its name or secret. A
Slack 404/410 pause is recorded with the delivery system as its actor.

The journal also supports workflow definition changes and synthetic previews. Definition
events keep the workflow ID and revision, with a trigger type for creation and updates to
content or enabled state. Preview events keep the space ID, trigger type and a fixed
reason code when a condition fails. Both use the space's existing audit permissions and
retention. Workflows remain off, so these actions produce no events today.

## Reading the audit log

Open **Audit log** in the navigation (shown to owners and admins). Filter by date range,
by who acted (an actor type and, optionally, an ID) and by action. Dates and times are in
the time zone of your profile, and the page names that zone; both dates of a range are
included, also on days when clocks change. Results are newest first, 50 per page.

| Surface | Read events | Read retention | Change retention |
| --- | --- | --- | --- |
| REST | `GET /api/v1/audit-events` | `GET /api/v1/audit-log/settings` | `PUT /api/v1/audit-log/settings` |
| MCP | `list_audit_events` | `get_audit_log_settings` | `set_audit_log_settings` |
| CLI | `hourmere audit-log list` | `hourmere audit-log settings` | `hourmere audit-log set-retention` |

All three answer the same way. Filters: `from` (inclusive) and `to` (exclusive) as RFC 3339
instants with an offset, `actorType` (`user`, `api_key`, `oauth_client`, `system`,
`scim_token`, `anonymous`, `external_api_key`, `external_oauth_client`, `external_user`),
`actorId` (with `actorType`), an exact `action`, `limit` (1–100, default 50) and `cursor`.
Pass `nextCursor` back with the same filters for the next page; pages never repeat an event
when new ones are written meanwhile. Times in responses are UTC with microseconds.

```sh
echo '{"from":"2026-11-01T00:00:00-07:00","action":"api_key.created","limit":20}' \
  | hourmere audit-log list --input -
```

**Who can read.** A personal space's owner, or a team's owners and admins, by browser
session, a **Full account access** API key, or an MCP OAuth connection. `read` and `bookings`
keys are refused with `insufficient_scope`: the audit log shows who did what with which key,
which is security information rather than reporting data. Members and anyone outside the team
get `team_management_access_denied`, the same answer whether or not a team exists. Reading the
audit log is not itself recorded.

**What you see.** Each event's time, action, actor, target, the recorded details and request
ID, and how the actor signed in: browser session, API key (with the key ID and its scope),
OAuth (client and grant) or none. Session IDs are never shown, and nothing beyond what was
recorded is added, so names, email addresses and secrets do not appear.

## Retention

| Setting | Who sets it | Values |
| --- | --- | --- |
| Instance default | the operator, `AUDIT_LOG_RETENTION_DAYS` | `forever` (default) or 30–3650 days |
| Your team or personal space | its owner | instance default, keep forever, or 30–3650 days |

Owners change it on the Audit log page or with `{"retention":"forever"}`,
`{"retention":"instance"}` or `{"retention":"days","retentionDays":365}`; admins can see it
but not change it. Each change is recorded as `audit_log.retention_updated`.

Once an hour the worker deletes events older than the retention, in small batches that never
wait on other database work; whatever one run does not reach, the next one does. Events
younger than 30 days are never deleted, whatever the setting.

**Compliance.** Retention deletes events; it is not an archive, and database backups follow
your own backup policy. Nothing in Hourmere refers to an audit event, so no event is kept
longer because of another record: only the 30-day minimum always applies. There is no legal
hold. If you must keep records (for example for an audit or a dispute), choose **Keep
forever** before the period runs out; shortening the period deletes older events within the
hour. The audit log stores IDs rather than names or email addresses, but it is still personal
data: choose the shortest period your obligations allow.

## Known limitations

- No export yet; page through the API to copy events elsewhere.
- No filter by target or credential, and one action at a time.
- People and keys are shown by ID. An API key actor shows the key ID, not its owner; the
  matching `api_key.created` event shows who created it.
- The operator cannot limit which retention an owner chooses, and there is no legal hold
  beyond **Keep forever**.
- Deletion runs on the worker; an installation without a worker process never deletes.

Purge deletion is limited to 50 batches of 1,000 rows per hourly run. Discovery still visits
all organizations, and later organizations may wait across runs while earlier ones remain
backlogged. Session targets are returned with a null ID to protect session identifiers.
