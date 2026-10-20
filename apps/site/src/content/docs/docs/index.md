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
- [Configuration reference](/docs/configuration): environment variables and Compose behavior.
- [Troubleshooting](/docs/troubleshooting): email delivery, workers, HTTPS, DNS and database
  startup failures.
- [Compare scheduling options](/docs/comparison): deployment, agent access and the current
  limitations of Hourmere alongside Calendly, Cal.com and Cal.diy.
- [REST quickstart](/docs/rest): create an API key and find, book and manage a time slot.
- [MCP quickstart](/docs/mcp): connect a client with an API key and use the booking tools.
- [Google Calendar](/docs/google-calendar): configure separate calendar authorization and
  choose busy-time calendars and a booking destination.
- [Microsoft Calendar](/docs/microsoft-calendar): register an Entra application and connect,
  refresh or disconnect an Outlook calendar list. Busy-time sync and event writes are pending.

## Known limitations

- [Microsoft Calendar](/docs/microsoft-calendar) lists calendars only, without busy-time
  synchronization or event writes. [Microsoft sign-in](/docs/configuration#sign-in-with-microsoft)
  and calendar connections have not had real-account acceptance.
- [Automatic Zoom](https://github.com/hourmere/hourmere/blob/main/docs/automatic-zoom.md)
  supports personal event types and individual team event types with one actual host;
  collective and round-robin event types are unsupported.
- [Calendar RSVP replies](https://github.com/hourmere/hourmere/blob/main/docs/notifications.md#email-headers-mime-and-replies)
  are not processed; declining in a calendar does not cancel an Hourmere booking. Use
  Hourmere's cancellation action; operators must [handle replies manually](/docs/self-hosting#handle-calendar-replies).
- PostgreSQL 18+ is required for `uuidv7()`; [PgBouncer is unsupported](/docs/configuration#server-and-database).
  The [upgrade notes](https://github.com/hourmere/hourmere/blob/main/CHANGELOG.md#upgrade-notes)
  cover the database version requirement.
- Hourmere must be served at the root of its own host name (no path prefix) in every deployment.
  [Bundled Caddy](/docs/self-hosting#prepare-the-host) additionally requires ports 80/443,
  an HTTPS host name without a port, and an IPv4-only ingress network.
- [Rate limiting](https://github.com/hourmere/hourmere/blob/main/apps/server/src/rate-limit.ts)
  uses in-process memory; multiple web replicas multiply the limits. Run a single web process;
  a [separate worker](/docs/self-hosting#run-workers-separately) is supported.
- [Interface languages](https://github.com/hourmere/hourmere/blob/main/docs/interface-languages.md)
  are English and Simplified Chinese only.
- [Schema downgrade is not automatic](/docs/self-hosting#upgrade-and-roll-back). Some
  migrations are not rolling-upgrade safe: stop all old app and worker processes as required
  by the [migration notes](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#changing-the-schema)
  and [calendar-email upgrade notes](https://github.com/hourmere/hourmere/blob/main/docs/notifications.md#identity-and-recipients).

## More guides on GitHub

These detailed guides remain in the repository:

- [CLI](https://github.com/hourmere/hourmere/blob/main/docs/cli.md): use the booking tools
  from a terminal with an API key.
- [Booking webhooks](https://github.com/hourmere/hourmere/blob/main/docs/webhooks.md):
  configure signed delivery and retries.
- Team scheduling: [collective meetings](https://github.com/hourmere/hourmere/blob/main/docs/collective-scheduling.md)
  and [round-robin pools](https://github.com/hourmere/hourmere/blob/main/docs/round-robin-scheduling.md).
- [Automatic Google Meet](https://github.com/hourmere/hourmere/blob/main/docs/automatic-google-meet.md)
  and [automatic Zoom](https://github.com/hourmere/hourmere/blob/main/docs/automatic-zoom.md):
  configure explicit meeting creation and recovery.
- [Notifications and background jobs](https://github.com/hourmere/hourmere/blob/main/docs/notifications.md):
  understand delivery, retries and calendar invitations.

The software is licensed under AGPL-3.0. File bugs and feature ideas in
[GitHub Issues](https://github.com/hourmere/hourmere/issues). Report vulnerabilities privately
to [security@hourmere.com](mailto:security@hourmere.com) or through the repository's
[Security tab](https://github.com/hourmere/hourmere/security/advisories/new).
