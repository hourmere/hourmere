---
title: Audit log
description: Management events recorded for every Hourmere instance.
---

Hourmere records audit events for sign-in session and sign-in method, membership,
API-key, [SCIM provisioning token](/docs/scim), OAuth, booking management,
[no-show mark](/docs/no-shows), webhook, [Slack destination](/docs/slack), event-type and
branding changes on every self-hosted and Cloud instance.
There is no enterprise-plan requirement. Only those changes are recorded: profile edits
(such as display names), schedules, one-time links, waitlist entries and calendar
connections are not.

**The audit log is recorded but not yet viewable.** The query UI, REST, MCP and CLI
read APIs, export and retention settings are planned separately. No automatic
retention cleanup runs yet.

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
