# Security policy

Hourmere handles calendars, bookings and API keys for people and their agents, so we take
security reports seriously. Thank you for helping keep its users safe.

## Supported versions

The `1.0.x` series and the `main` branch receive security fixes; older releases do not.
Self-hosters should update to the latest `1.0.x` patch release to get a fix.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull request or
discussion for them.

- **Email:** [security@hourmere.com](mailto:security@hourmere.com)
- **GitHub:** use **Report a vulnerability** on the repository's
  [Security tab](https://github.com/hourmere/hourmere/security).

Reports are handled in writing, in English or Chinese, by email or on GitHub. Phone and video
calls are not available.

The hosted website publishes these channels at `https://hourmere.com/.well-known/security.txt`
and `https://www.hourmere.com/.well-known/security.txt`. Its source is
`apps/site/public/.well-known/security.txt`; renew its `Expires` date before it is within
30 days, keeping it at most one year ahead when publishing. See
[the renewal steps](docs/releasing.md#renew-the-hosted-security-policy).

### What to include

- The affected version, release or commit, and the component (API server, web app, website,
  a package in `packages/`, the Docker image).
- What the vulnerability is and what an attacker could do with it.
- Steps to reproduce, ideally a minimal proof of concept.
- Any non-default configuration needed to reproduce it (relevant environment variables, the
  reverse proxy setup), with secrets removed.
- Whether and how you would like to be credited.

## What happens next

Hourmere is maintained by one person, so these targets are best effort:

- **Acknowledgement** within 3 business days of your report.
- **Initial assessment** (whether we can reproduce it, how severe we think it is, and what
  happens next) within 10 business days.

After that we keep you informed as we work on a fix, and we may ask you to check it.

## Coordinated disclosure

We ask you to give us 90 days from your report before disclosing it publicly, or less if a
fix is released sooner. If a fix needs more time, we will tell you why and agree on a new date
with you. When the fix is out, we publish a
[GitHub security advisory](https://github.com/hourmere/hourmere/security/advisories) and credit
you unless you prefer to remain anonymous.

## Scope

In scope:

- The code in this repository.
- Docker images built from this repository's `Dockerfile`.
- The hourmere.com website and Hourmere hosted services operated by Cobaltmere, LLC,
  including vulnerabilities in their application code or service configuration. Report
  these through the same private channels above.

Out of scope:

- Social engineering, phishing or physical attacks against Cobaltmere, LLC, its maintainers
  or its users.
- Denial-of-service and volume or load tests. Report a resource-exhaustion bug with a small
  proof of concept instead of demonstrating it at scale.
- Third-party services and dependencies (email providers, Google or Microsoft sign-in, Better
  Auth, other npm packages). Report those to their maintainers; if Hourmere uses one in a way
  that makes it exploitable, that part is in scope.
- Misconfiguration of a self-hosted instance by its operator, such as running a public
  instance without SMTP (which prints sign-in links to the server log, as the README warns)
  or exposing the database to the internet.

Test against an instance you run yourself (see [Self-hosting](README.md#self-hosting)), using
synthetic accounts and data. Obtain explicit permission before security testing a live
Cobaltmere service or anyone else's instance. If you notice a potential hosted-service issue
through ordinary use, report what you observed privately and stop before accessing another
person's data. We can coordinate any further testing through the reporting channels above.

## Safe harbor

If you research and report in good faith and follow this policy, we consider your research
authorized, we will not pursue or support legal action against you for it, and we will work
with you to understand and fix the issue. Good faith means that you:

- avoid privacy violations, destroying or changing data, and disrupting service;
- access only the data you need to demonstrate the issue, stop as soon as you reach other
  people's data, and do not keep or share it;
- do not exploit the issue beyond what is needed to show it;
- give us reasonable time to fix it before disclosing, as described above.

This covers Cobaltmere, LLC and Hourmere only. We cannot authorize testing of systems that
belong to others, including third-party services and other people's self-hosted instances.

## No bug bounty

Hourmere does not run a bug bounty program and does not pay for reports. With your
permission, we are glad to credit you in the advisory and the release notes.
