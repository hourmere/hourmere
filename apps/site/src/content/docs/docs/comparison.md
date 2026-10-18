---
title: Compare scheduling options
description: Compare Hourmere, Calendly, Cal.com and Cal.diy by deployment, agent access and current limitations.
lastVerified: '2026-10-18'
---

Hourmere's [README](https://github.com/cobaltmere/hourmere/blob/main/README.md) describes an
early development project for self-hosted scheduling and agent access. This page describes
the documented implementation, rather than promising feature parity with an established
service.

The verification date above applies to the linked sources on this page. Follow them for
current availability, terms and plan requirements before choosing a service.

## Deployment and ownership

| Option | Deployment | Source and operating responsibility |
| --- | --- | --- |
| Hourmere | Build from source with Docker Compose: application and PostgreSQL; workers can run separately. See [self-hosting](/docs/self-hosting). | [AGPL-3.0-only](https://github.com/cobaltmere/hourmere/blob/main/package.json). You operate the instance, backups, email delivery and calendar credentials; see the [configuration reference](/docs/configuration) and [backup guide](/docs/self-hosting#back-up-and-restore). |
| Calendly | Vendor-hosted scheduling and MCP service. See its [service terms](https://calendly.com/legal/customer-terms-conditions) and [MCP documentation](https://developer.calendly.com/docs/mcp/calendly-mcp-server). | Its [MCP documentation](https://developer.calendly.com/docs/mcp/calendly-mcp-server) explicitly excludes self-hosting or local deployment of that server. |
| Cal.com | Managed service or commercial enterprise self-hosting, as described in its [self-hosting guide](https://cal.com/blog/self-hosted-scheduling-platforms-benefits-and-challenges). | Cal.com's [transition announcement](https://cal.com/blog/cal-diy-open-source-to-closed-source) describes a private production codebase. Its [self-hosting guide](https://cal.com/blog/self-hosted-scheduling-platforms-benefits-and-challenges) directs enterprise deployments through its team. |
| Cal.diy | Community edition installed on your infrastructure; see its [README](https://github.com/calcom/cal.diy/blob/main/README.md). | [MIT-licensed](https://github.com/calcom/cal.diy/blob/main/LICENSE). Its [self-hosting documentation](https://www.cal.diy/) recommends personal, non-production use and describes the operator's responsibilities. |

Cal.com and Cal.diy are different offerings. Cal.com's
[technical transition announcement](https://cal.com/blog/cal-diy-open-source-to-closed-source)
describes the private production codebase and MIT community edition. Its
[self-hosting guide](https://cal.com/blog/self-hosted-scheduling-platforms-benefits-and-challenges)
explains commercial enterprise self-hosting. The
[Cal.diy self-hosting documentation](https://www.cal.diy/)
describes its installation model and operating warning.

For Hourmere's actual setup and maintenance requirements, read the
[self-hosting guide](/docs/self-hosting), [configuration reference](/docs/configuration)
and [security policy](https://github.com/cobaltmere/hourmere/blob/main/SECURITY.md).

## Access for agents

Hourmere accepts an organization-bound API key for REST and MCP. Once a verified user
has created a key, a script or agent can discover configuration, find slots and manage
bookings without a browser authorization flow. Creating an account and obtaining a key are
still setup steps; possession of a key grants the permissions described in the
[REST authentication conventions](https://github.com/cobaltmere/hourmere/blob/main/docs/api-conventions.md#authentication)
and [MCP protocol documentation](https://github.com/cobaltmere/hourmere/blob/main/docs/mcp.md#authentication).

Hourmere's [MCP protocol documentation](https://github.com/cobaltmere/hourmere/blob/main/docs/mcp.md#oauth-21-connectors)
also describes an opt-in OAuth connector protocol. It distinguishes local protocol tests
from hosted-client acceptance: an actual hosted connection needs an externally reachable
HTTPS instance and separate verification with the intended client.

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

Hourmere documents [personal booking and availability](/docs/self-hosting),
[individual and collective team links, unlisted event types and booking changes](https://github.com/cobaltmere/hourmere/blob/main/docs/api-conventions.md#public-endpoints),
[queued email](https://github.com/cobaltmere/hourmere/blob/main/docs/notifications.md),
[opt-in inline and popup widgets](/docs/embedding), and
[Google Calendar connections, busy-time synchronization and booking event writes](/docs/google-calendar).
The [README](https://github.com/cobaltmere/hourmere/blob/main/README.md) identifies the
project as development software.

Check the documented limits when evaluating it:

- [Microsoft calendar connections](/docs/microsoft-calendar) list calendars and refresh
  credentials, but do not synchronize busy times or write booking events.
- [Automatic Google Meet](https://github.com/cobaltmere/hourmere/blob/main/docs/automatic-google-meet.md)
  supports individual, collective and explicitly activated round-robin scheduling with a
  pinned organizer and pending/failure states.
- [Automatic Zoom](https://github.com/cobaltmere/hourmere/blob/main/docs/automatic-zoom.md)
  supports personal and individual single-host team events. Collective and round-robin
  automatic Zoom are rejected.
- [Round-robin pools](https://github.com/cobaltmere/hourmere/blob/main/docs/round-robin-scheduling.md)
  support one to eight hosts with explicit activation. Newly saved and legacy pools remain
  unbookable until activated; ordinary metadata saves never activate them. Assignment uses
  current availability and equal rotation.

Cal.com's [transition announcement](https://cal.com/blog/cal-diy-open-source-to-closed-source)
and [Cal.diy documentation](https://www.cal.diy/) distinguish the community edition from
commercial Cal.com: Cal.diy excludes teams, organizations, workflows, SSO and the Insights
dashboard. This does not exclude the analytics integrations listed in the Cal.diy
documentation. Check the edition's feature list rather than assuming identical features.

For any option, try the complete workflow with your intended client and provider: discover
availability, book, retry a request, reschedule, cancel, and check the resulting calendar and
email. Confirm permissions, recovery and data-retention needs against that product's
documentation.

## Product names and independence

Calendly is a trademark of Calendly, LLC; see its
[legal definitions](https://calendly.com/legal/definitions) and
[intellectual property terms](https://calendly.com/legal/customer-terms-conditions).
Cal.com is a trademark of Cal.com, Inc.; see its
[trademark notice](https://cal.com/shop). Cal.diy is a trademark of Cal.com, Inc.; see the
[Cal.diy trademark notice](https://www.cal.diy/). Other product names identify their respective
products; any associated trademarks belong to their respective owners.

Hourmere is not affiliated with or endorsed by Calendly, Cal.com or the Cal.diy project.
