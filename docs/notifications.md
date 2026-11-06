[Notifications and background jobs](https://hourmere.com/docs/notifications).

If the original inviter leaves or is removed from the team, their pending invitations are
no longer valid. Neither resend nor the expired-row replacement action can reuse them:
both refuse with `INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION`.
Acceptance uses the same error code.
Native recipient invitation discovery omits these rows. They grant no signup exception:
an otherwise ineligible address receives no sign-in email and cannot create an account.
A current owner/admin must cancel any old pending invitation and send a fresh invitation
in their own name through the invite form.
The administrator list shows **No longer valid**, with derived `invalidReason: "inviter_left"`;
cancellation remains allowed. Demotion while the inviter remains a member leaves validity
unchanged. These checks do not rewrite the invitation's stored lifecycle.

## Operator SMS foundation

SMS is an internal operator-configured foundation, with no reminder or workflow surface.
See [SMS provider foundation](../apps/site/src/content/docs/docs/sms-provider.md) for the
supported default Twilio endpoint, credentials, limits and errors. Sending is disabled
without `SMS_PROVIDER`; hourly metadata retention still runs on active workers and scrubs
delivery details 30 days after the latest reserved attempt in bounded batches. SMS costs belong to the operator.

A provider 429 is a known non-send and releases local budgets. The same job key may retry
after its bounded database retry-not-before time (1–3600 seconds, default 60); early retries
return `sms_rate_limited` with the remaining delay. Other ambiguous outcomes keep their
reservation and cannot resend. Keep `SMS_HASH_KEY` stable and backed up: its purpose-keyed
HMAC protects destination, request and permanent job-key tombstones, and rotating it would
reset recipient accounting and defeat deduplication.
