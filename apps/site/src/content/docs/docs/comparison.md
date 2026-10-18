---
title: Compare scheduling options
description: Compare Hourmere, Calendly, Cal.com and Cal.diy by deployment, agent access and current limitations.
---

Hourmere is an early development project for people who want to run their own scheduling
service and connect agents through an API key. There is no stable release, public
container image or hosted Hourmere booking service yet. The current repository is private;
evaluating it requires access. This page describes the current source, rather than promising
feature parity with an established service.

Vendor documentation was checked on October 17, 2026. Follow the linked sources for current
availability, terms and plan requirements before choosing a service.

## Deployment and ownership

| Option | Deployment | Source and operating responsibility |
| --- | --- | --- |
| Hourmere | Build from the repository with Docker Compose: application and PostgreSQL; workers can run separately. | AGPL-3.0-only. You operate the instance, backups, email delivery and calendar credentials. |
| Calendly | Vendor-hosted scheduling service. Its MCP server is also vendor-hosted. | Calendly operates its service; its MCP documentation does not offer self-hosting of that server. |
| Cal.com | Managed service or commercial enterprise self-hosting. | The current commercial codebase is private. Enterprise self-hosting is arranged through Cal.com. |
| Cal.diy | Community edition installed on your infrastructure. | MIT-licensed. Its maintainers recommend personal, non-production use and leave operations to the self-hoster. |

Cal.com and Cal.diy are different offerings. Cal.com's
[technical transition announcement](https://cal.com/blog/cal-diy-open-source-to-closed-source)
describes the private production codebase and MIT community edition. Its
[self-hosting guide](https://cal.com/blog/self-hosted-scheduling-platforms-benefits-and-challenges)
explains commercial enterprise self-hosting. The
[Cal.diy README](https://github.com/calcom/cal.diy/blob/main/README.md)
describes its installation model and operating warning.

For Hourmere's actual setup and maintenance requirements, read the
[self-hosting guide](/docs/self-hosting), [configuration reference](/docs/configuration)
and [security policy](https://github.com/cobaltmere/hourmere/blob/main/SECURITY.md).
The repository link requires access while the project remains private.

## Access for agents

Hourmere accepts an organization-bound API key for REST and MCP. Once the instance owner
has created a key, a script or agent can discover configuration, find slots and manage
bookings without a browser authorization flow. Creating an account and obtaining a key are
still setup steps; possession of a key grants the permissions described in the
[MCP quickstart](/docs/mcp).

Hourmere also has an opt-in OAuth connector protocol for clients that need it. Local
protocol tests are separate from a successful connection to a hosted client: actual
ChatGPT or claude.ai interoperability has not been verified. A hosted connector needs an
externally reachable HTTPS instance. See the
[MCP protocol documentation](https://github.com/cobaltmere/hourmere/blob/main/docs/mcp.md)
for the current implementation and limits.

Calendly also has both a REST API and MCP support. Its
[REST API introduction](https://developer.calendly.com/docs/getting-started/introduction)
documents personal access tokens and OAuth. Its
[MCP authentication documentation](https://developer.calendly.com/docs/mcp/calendly-mcp-server)
requires OAuth Authorization Code with PKCE and dynamic client registration; personal
access tokens are not accepted by that MCP server. This is a transport-specific difference,
not a claim that Calendly has no API access for scripts.

Cal.com's [transition announcement](https://cal.com/blog/cal-diy-open-source-to-closed-source)
says Cal.diy retains API v2 alongside its booking engine. Check the particular edition's
API and authentication documentation for your integration; an API in one offering does
not establish compatible MCP support in another.

## Check the features you need

The current Hourmere source includes personal booking pages, individual and collective team links,
unlisted event types, availability rules, booking changes and cancellations, queued email,
and opt-in inline and popup widgets. Google Calendar connection, busy-time synchronization
and booking event writes have been tested. These capabilities remain development software.

Before evaluating it for real scheduling, account for the unfinished work:

- Microsoft calendar connection and calendar-list support exist; Graph busy-time
  synchronization and booking event writes are pending.
- Cross-browser widget acceptance beyond Chrome is pending. A mobile viewport test does
  not establish Safari or Firefox compatibility.
- Real Gmail, Outlook and Apple calendar invitation lifecycle and inbox-delivery acceptance
  are pending; local mail/ICS tests do not establish deliverability.
- Optional automatic Google Meet supports individual, collective and round-robin scheduling with pinned organizer identity and pending/failure states. Explicit automatic Zoom supports personal and individual single-host team events; collective/round-robin automatic Zoom, billing and a managed Hourmere service are not available.
- Team round-robin pools support one to eight hosts with explicit activation. Newly saved
  and legacy pools remain unbookable until activated; ordinary metadata saves never activate
  them. Assignment uses current availability and equal rotation.
- Public release, fresh-machine deployment acceptance and four weeks of actual self-use
  have not been completed.

Cal.diy explicitly excludes commercial features such as teams, organizations, workflows,
SSO and analytics in its current README. If your evaluation needs them, distinguish the
community edition from commercial Cal.com rather than assuming identical features.

For any option, try the complete workflow with your intended client and provider: discover
availability, book, retry a request, reschedule, cancel, and check the resulting calendar and
email. Confirm permissions, recovery and data-retention needs against that product's
documentation. Hourmere does not currently provide an automated migration from another
scheduling service.
