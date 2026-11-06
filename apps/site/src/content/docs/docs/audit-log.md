---
title: Audit log
description: Management events recorded for every Hourmere instance.
---

Hourmere records audit events for account, membership, API-key, OAuth, booking
management, webhook and event-type changes on every self-hosted and Cloud instance.
There is no enterprise-plan requirement.

**The audit log is recorded but not yet viewable.** The query UI, REST, MCP and CLI
read APIs, export and retention settings are planned separately. No automatic
retention cleanup runs yet.

Events identify the organization, time, actor, credential used, action, target and
request. Same-organization agent actions retain the API-key ID and scope. Foreign-key
public bookings record an external actor without that key’s ID. OAuth actions retain the
client and grant IDs. Events and the recorded change share a database transaction:
if the event cannot be written, the change fails too.

The journal does not copy secrets, tokens, passwords, raw emails, invitee answers,
IP addresses or user agents. Public invitee actions retain entity IDs only.
