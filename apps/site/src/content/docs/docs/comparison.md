---
title: Compare scheduling options
description: Compare Hourmere, Calendly, Cal.com and Cal.diy by deployment, agent access and current limitations.
lastVerified: '2026-10-20'
---

Hourmere Cloud is in an [invitation-only preview](/#faq) with sign-ups closed, and the
open-source release for self-hosting is planned for November 30, 2026. Its
[self-hosting guide](/docs/self-hosting) installs the published image pinned to an exact release version;
building from source remains an alternative.
This page describes the documented implementation and its current limitations.

The verification date above applies to the linked sources on this page. Follow them for
current availability, terms and plan requirements before choosing a service.

## Deployment and ownership

| Option | Deployment | Source and operating responsibility |
| --- | --- | --- |
| Hourmere | Use a published image with Docker Compose: application and PostgreSQL; workers can run separately. See [self-hosting](/docs/self-hosting). | You operate the instance, backups, email delivery and calendar credentials; see the [configuration reference](/docs/configuration) and [backup guide](/docs/self-hosting#back-up-and-restore). |
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
and [security policy](https://github.com/hourmere/hourmere/security/policy).

## Access for agents

Hourmere accepts an organization-bound API key for REST and MCP. Once a verified user
has created a key, a script or agent can discover configuration, find slots and manage
bookings without a browser authorization flow. Creating an account and obtaining a key are
still setup steps; possession of a key grants the permissions described in the
[REST quickstart](/docs/rest) and [MCP quickstart](/docs/mcp).

Hourmere's [MCP OAuth guide](/docs/mcp#connect-with-oauth) also describes opt-in browser
authorization, explicit organization approval and revocation through Connected apps.
The instance needs HTTPS outside loopback development; verify the intended hosted client
separately before relying on it. See the
[MCP protocol documentation](/docs/mcp)
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

Hourmere documents [personal booking and availability](/docs/self-hosting),
[booking creation, rescheduling and cancellation](/docs/rest),
[opt-in inline and popup widgets](/docs/embedding), and
[Google Calendar connections, busy-time synchronization and booking event writes](/docs/google-calendar).

Check the documented limits when evaluating it:

- [Microsoft calendar connections](/docs/microsoft-calendar) list calendars and refresh
  credentials, but do not synchronize busy times or write booking events.
- [Zoom account connections](/docs/zoom-connections) are separate from sign-in and calendar
  connections. Identity-only authorization does not create or read meetings.

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

Calendly and Cal.com are trademarks of their respective owners; Hourmere is not affiliated with or endorsed by them.
