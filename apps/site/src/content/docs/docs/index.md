---
title: Documentation
description: Run Hourmere yourself and connect booking clients through REST or MCP.
---

Hourmere is in early development. These guides describe the current source tree; there is
no stable release or hosted booking service yet. The website at hourmere.com is separate
from your Hourmere instance.

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
