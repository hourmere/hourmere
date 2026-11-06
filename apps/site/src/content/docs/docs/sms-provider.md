---
title: SMS provider foundation
description: Operator-owned Twilio configuration, durable sending limits and current limitations.
---

Hourmere includes an internal SMS provider foundation for self-hosted instances. **There
are no user-facing SMS reminders, workflow actions, host settings, REST endpoints, MCP
tools or CLI commands yet.** Configuring this foundation schedules only hourly metadata cleanup, never SMS sending jobs.
An unconfigured internal send fails closed with `sms_not_configured`.

SMS usage is billed to **the instance operator's own Twilio account**. No Hourmere company
account or credentials are involved. Operators remain responsible for recipient consent,
applicable sender registration and Twilio account policies.

## Configure the operator account

Set these environment variables identically on the server and every worker, then recreate
the processes. The supplied Compose files forward them from your private `.env`.

| Variable | Meaning |
|---|---|
| `SMS_PROVIDER` | Set `twilio`; unset means off. |
| `TWILIO_ACCOUNT_SID` | Account SID beginning with `AC`. Required with either authentication method. |
| `TWILIO_AUTH_TOKEN` | Account Auth Token. Use this **or** the API key pair below. |
| `TWILIO_API_KEY_SID` | API key SID beginning with `SK`. |
| `TWILIO_API_KEY_SECRET` | Secret paired with the API key SID. |
| `TWILIO_MESSAGING_SERVICE_SID` | Messaging Service SID beginning with `MG`. Use this **or** `TWILIO_FROM`. |
| `TWILIO_FROM` | SMS-capable Twilio sender number in international E.164 form, such as `+12025550123`. |
| `SMS_HASH_KEY` | Independent random 32-byte base64 key, generated with `openssl rand -base64 32`. Keep stable and backed up. |

`TWILIO_AUTH_TOKEN_FILE`, `TWILIO_API_KEY_SECRET_FILE` and `SMS_HASH_KEY_FILE` read the
corresponding secret from a file instead of an environment value. Set only one form for
each secret. A single trailing newline is removed. Empty/unreadable files fail startup
without disclosing their paths or contents. In containers, mount the files read-only and
use their **container paths**; Compose forwards paths but does not create secret mounts.
Apply the mounts to both the app and any separate worker. Keep SMS settings identical
on every role; disabling SMS removes its persisted cleanup schedule at startup. Other configuration retains
its existing environment-only behavior.

Partial credentials, conflicting authentication methods/senders, malformed SIDs, invalid
limits and reused authentication/encryption hash keys fail startup in every process role.
There is no endpoint URL override: requests use Twilio's HTTPS Messages API, with bounded
timeouts and redirects disabled. The fixed provider URL has no user-controlled host;
the generic outbound webhook URL guard is not used. Credentials are never stored in
the database. Keep the hash key unchanged: rotating it changes destination hashes and
resets the effective per-number counters; stop sending during any planned key migration.

Twilio documents [HTTP Basic authentication](https://www.twilio.com/docs/usage/requests-to-twilio)
using the Account SID/Auth Token or API Key SID/secret. The
[Messages API](https://www.twilio.com/docs/messaging/api/message-resource) accepts
`MessagingServiceSid` or `From` and returns a message SID when accepted. Acceptance is not
confirmation of delivery. Status callbacks are deferred: Hourmere adds no callback
endpoint and sends no callback URL. A Messaging Service can have its own account-side
callbacks; manage those separately in Twilio.

## Durable abuse limits

| Variable | Default |
|---|---:|
| `SMS_RECIPIENT_MAX_PER_HOUR` | 3 |
| `SMS_RECIPIENT_MAX_PER_DAY` | 10 |
| `SMS_MAX_PER_HOUR` | 100 |
| `SMS_ORGANIZATION_MAX_PER_DAY` | 50 |

Limits must be positive whole numbers, at most 2147483647. PostgreSQL enforces all four
budgets before contacting Twilio, across process restarts and concurrent workers. Windows
are rolling elapsed hours and 24-hour days, independent of local time zones and DST.
Failed and ambiguous attempts consume budget too. All
instances sharing a database share the instance budget; an organization's daily budget
also applies to its destinations. Configure the same ceilings on every process.

These are conservative application abuse budgets, **not Twilio throughput guarantees**.
Twilio describes [429/concurrency limits](https://www.twilio.com/docs/api/errors/20429),
and [message throughput and queues](https://www.twilio.com/docs/messaging/guides/scaling-queueing-latency)
depend on sender type and registration. A low per-number allowance limits repeated
harassment; instance and organization budgets bound aggregate abuse. Raise them only
with a considered usage budget and account-side geographic permissions and spending alerts.
Limits count attempted API messages, not SMS segments or money. A body can contain up to
1600 characters and become multiple billable segments; Unicode may increase segment use.

Destinations use the project's international phone syntax and phone metadata validation.
Only mobile or mixed fixed-line/mobile classifications are accepted. Short codes,
premium-rate numbers and other/unknown classifications are denied; no paid lookup call
is made. Metadata cannot prove current carrier ownership, reachability or absence of
number reassignment. Twilio geographic permissions provide an additional operator control.

Each logical job must retain one idempotency key. Hourmere reserves that key before the
provider call and never dispatches it twice, including after a timeout, process crash or
429 response. This favors at-most-once attempts: a crash before sending can lose a message,
and an ambiguous response cannot be automatically retried safely because the Messages
API does not document a create-message idempotency guarantee. A repeated key returns its
stored result or a typed terminal/uncertain result. Future workflows must decide whether
a new logical send is appropriate; changing a key merely to retry bypasses this protection.

## Privacy and retention

Hourmere does not log message bodies or full destination numbers. Delivery accounting
stores a keyed destination hash, a masked number, provider message ID, status and timestamps;
it does not store message bodies or Twilio credentials. Details are scrubbed after 30 days
by bounded hourly cleanup on configured instances, configured-send maintenance or the
internal maintenance operation. Cleanup processes at most 1000 records per run, so large
backlogs can require multiple runs. Disabling SMS also disables its scheduled cleanup;
run internal maintenance before retiring an installation. Minimal irreversible job-key tombstones
remain so old retries cannot send again. Twilio has its own message storage and retention;
configure those policies separately in the operator account.
