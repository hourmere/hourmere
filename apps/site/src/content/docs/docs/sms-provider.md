---
title: SMS provider foundation
description: Operator-owned Twilio configuration, durable sending limits and current limitations.
---

Hourmere includes an internal SMS provider foundation for self-hosted instances. **There
are no user-facing SMS reminders, workflow actions, host settings, REST endpoints, MCP
tools or CLI commands yet.** Hourly metadata cleanup runs even when SMS is disabled; this foundation never schedules SMS sending jobs.
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
on every role; disabling SMS leaves its metadata cleanup schedule active. Other configuration retains
its existing environment-only behavior.

Partial credentials, conflicting authentication methods/senders, malformed SIDs, invalid
limits and reused authentication/encryption hash keys fail startup in every process role.
There is no endpoint URL override: requests use Twilio's HTTPS Messages API, with bounded
timeouts and redirects disabled. The fixed provider URL has no user-controlled host;
the generic outbound webhook URL guard is not used. Credentials are never stored in
the database. Only the default Twilio US1 endpoint (`api.twilio.com`) is supported;
regional accounts in IE1 and AU1 are unsupported.
Keep the hash key unchanged and backed up: rotating it changes both destination and
job-key hashes, resets per-number accounting and defeats deduplication of old job keys.
Do not rotate it without a separate data/key migration.

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
Failed and ambiguous attempts consume budget too; provider 429 responses do not. All
instances sharing a database share the instance budget; an organization's daily budget
also applies to its destinations. Configure the same ceilings on every process.

These are conservative application abuse budgets, **not Twilio throughput guarantees**.
Twilio describes [429/concurrency limits](https://www.twilio.com/docs/api/errors/20429),
and [message throughput and queues](https://www.twilio.com/docs/messaging/guides/scaling-queueing-latency)
depend on sender type and registration. A low per-number allowance limits repeated
harassment; instance and organization budgets bound aggregate abuse. Raise them only
with a considered usage budget and account-side geographic permissions and spending alerts.
Limits count attempted API messages except provider 429 responses, not SMS segments or money. A body can contain up to
1600 characters and become multiple billable segments; Unicode may increase segment use.

Destinations use the project's international phone syntax and phone metadata validation.
Only mobile or mixed fixed-line/mobile classifications are accepted. Short codes,
premium-rate numbers and other/unknown classifications are denied; no paid lookup call
is made. Metadata cannot prove current carrier ownership, reachability or absence of
number reassignment. Twilio geographic permissions provide an additional operator control.

Each logical job must retain one idempotency key. Hourmere reserves that key before the
provider call. A provider 429 is a known non-send: its `rate_limited` record releases the
local budgets and stores a retry-not-before time using the database clock. `Retry-After`
is bounded to 1–3600 seconds, defaulting to 60 seconds when missing or invalid. Retrying
before that time returns `sms_rate_limited` with the remaining `retryAfterSeconds`.
After that time the same key can reserve again under the shared database lock, after
checking the request fingerprint and all budgets; concurrent retries dispatch only once.

Other outcomes retain the reservation. Accepted requests return their stored result,
and definitive provider rejections remain `sms_provider_rejected`. A timeout first returns
`sms_timeout`; its stored result, transport failures, 5xx responses and process crashes
return `sms_delivery_unknown` on retry. These uncertain reservations cannot
be retried automatically because the Messages API does not document a create-message
idempotency guarantee. A crash before sending can lose a message. Future workflows must
decide whether a new logical send is appropriate; changing a key merely to retry bypasses
this protection.

## Privacy and retention

Hourmere does not log message bodies or full destination numbers. Delivery accounting
stores purpose-separated keyed destination, request and job-key hashes, a masked number,
provider message ID, status and timestamps; it does not store message bodies or Twilio
credentials. Details are scrubbed 30 days after the latest reserved attempt by bounded hourly cleanup on every running
worker, even when SMS is disabled, and by configured-send maintenance. Cleanup processes
at most 1000 records per run, so large backlogs can require multiple runs. Keep a worker
running to drain the backlog after disabling SMS; a stopped installation cannot run cleanup.
Minimal keyed job tombstones remain so old retries cannot send again. Twilio has its own
message storage and retention; configure those policies separately in the operator account.
