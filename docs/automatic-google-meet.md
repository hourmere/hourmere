# Automatic Google Meet

Automatic Meet is an explicit instance and event-type opt-in for individual, collective and explicitly activated round-robin meetings. Set `GOOGLE_MEET_ENABLED=true` with the existing Google Calendar OAuth/write configuration, refresh the host's calendar list, select an owned calendar that advertises Meet support, and explicitly enable automatic creation on the event type. There is no extra OAuth scope beyond the current Calendar synchronization scopes. Google account policy can still refuse creation after booking.

The feature flag defaults off and gates new automatic configurations/bookings. Turning it off does not abandon already committed intents: existing authorized roots continue to create/reconcile/update/cancel while their Google connection is available. Removing Google write configuration or disconnecting a pinned account produces an actionable failure rather than silently leaving a pending state or claiming remote cancellation succeeded.

Existing `{kind:"google_meet"}` and `{kind:"zoom"}` locations keep their label-only behavior. The explicit automatic input is `{kind:"google_meet",autoCreate:true}`. Saving ordinary metadata never opts an old event type into provider requests. Existing label-only bookings are not backfilled. Collective meetings require an explicit organizer from the complete required-host set. Round robin uses its actual committed winner after filtering cached Meet eligibility, without changing fairness among eligible available hosts. Automatic Zoom meeting creation is a separate feature; a Zoom identity connection alone cannot create meetings.

## Booking and notifications

The booking reserves the selected time immediately. Its protected details report `conference: {provider:"google_meet",status:"pending"|"ready"|"failed",errorCode:string|null}`. A pending page is truthful: the meeting link and final invitation are not ready yet. Polling uses the existing authenticated booking endpoint or `X-Manage-Token` header, with the capability held only in page memory.

The English/Chinese editor requires an explicit automatic-creation checkbox. Existing opt-ins can be switched off, and unchanged location/schedule settings are omitted from metadata-only edits so disabling the instance capability does not block editing a title. Public confirmation and manage pages and the host booking page show pending, ready or actionable failure states. Pending public confirmations withhold all calendar downloads/add links. Status reads stop after 30 bounded polls or a read failure, with an explicit read-only recheck. A cancellation, changed booking identity or unmount aborts old reads and retries and rejects their late results; changing interface language preserves the form and in-memory capability. Retry writes are never repeated automatically.

Only a ready current booking revision gets the resolved HTTPS Meet URL in protected `booking.location`. Confirmed/rescheduled emails, REQUEST ICS attachments and reminders are held until that revision is ready. On success the same URL appears in text/HTML email and ICS. An independent durable notification outbox avoids losing release behind an older active exclusive notification job. Dispatch normally runs once a minute. Existing queued jobs also recheck readiness immediately before each recipient send.

A terminal provisioning failure sends a separate “Meeting link needs attention” notice to the verified host and original invitee, with no REQUEST ICS. The invitee receives the existing safe manage link. The host can inspect the protected booking and request a safe retry with `POST /api/v1/bookings/{id}/conference/retry` and an empty JSON object. This is not a force-create operation. Guests do not receive this logistical failure notice. A later move, cancellation or recovery suppresses an obsolete notice. A failure discovered at meeting start can still send this logistical notice; final invitations and reminders never send after start.

If the host is deleted or loses verified email status while a team booking remains, the original invitee still gets the no-ICS failure notice using a generic host label. The unavailable/unverified host receives nothing. Failure delivery does not fall back to a guest when the original invitee is absent; its outbox stays pending rather than claiming delivery. Transient mail refusal also retains the outbox for retry.

Cancellation remains available while creation is pending or failed, and its cancellation mail/CANCEL ICS is not held behind provisioning. A cancelled local booking can still report failed remote cleanup if credentials are unavailable; local cancellation does not claim that Google Meet access was revoked. The development log mailer suppresses sensitive meeting-message bodies entirely rather than printing join/manage capabilities; configure SMTP for actual email delivery.

Old0021 roots still send an honest cancellation email without ICS if their same pinned organizer is no longer verified. New roots can use the immutable logical organizer identity in CANCEL while sending only to current verified original participants and existing invitees. This logistical notice does not automatically remove an event from the invitee's calendar client; the invitee may need to remove it manually. All host recipients are rechecked against their current verified address before sending; an obsolete host recipient is skipped without suppressing the invitee. REQUEST invitations continue to require a verified organizer.

The pinned host can safely retry failed cleanup after reconnecting the original account, including after the meeting start. Cleanup retry never creates an event or sends a new invitation. A ready cancelled state means that the provider event is cancelled (or there was a known rejection before any create); it does not promise that an existing Meet link is revoked.

## Retry, identity and concurrency

One root booking chain has one pinned organizer, destination and conference-bearing Google event, with UID `<root-booking-id>@hourmere`. An idempotent booking retry adds no intent or provider request. A reschedule retains the event and Meet URL while updating its dates; the successor is pending until its own revision is applied. Changing profile destinations does not move an existing chain to another calendar. Disconnecting never deletes the durable intent, never transfers it to another account and never changes an ambiguous import into permission to import again. A ready URL remains available on the original protected booking; a subsequent move with missing credentials becomes an explicit failure.

Google conference creation can be pending, successful or failed. The job persists a conference request identity before the first import, commits its claim, and performs bounded provider work under the established owner KEY SHARE / connection UPDATE protocol. It finishes that credential transaction before a separate short booking-row → intent-row result transaction. No booking, host-advisory or intent lock crosses a network call, and polling sleeps never hold the connection transaction. Lease/revision checks reject stale results and releases; pending jobs and worker crashes are recovered by a dispatcher.

Known pending event IDs are persisted with the existing calendar-event mapping before readiness, so busy polling cannot make the host's own copy block an overlapping legal reschedule. The conference worker is the only authority for the organizer event. For new roots, the ordinary writer separately reconciles the frozen non-organizer targets after the current conference revision is ready. For old0021 roots it retains the original whole-root skip; no new copy is inferred.

A transport failure after an import may hide a successful provider side effect. That state is `ambiguous_create`: recovery only looks up the known ID or strict root UID and never blindly repeats the import. Zero lookup does not prove absence. A host retry repeats safe reconciliation, not creation. If Google reports a known failed conference on an identified event, an explicit retry uses a fresh conference request ID on that same event. A known rejected HTTP 400/401/403/404 can be distinguished from an unknown transport/5xx outcome; Calendar 400 does not automatically revoke an otherwise valid token. No provider error body is retained or echoed.

An initial worker crash after committing its create claim but before the request reaches Google can consequently require host intervention even if no event was created. This conservative outcome avoids duplicate meetings without relying on an undocumented import idempotency guarantee. External deletion or an unrecoverable ambiguous create is not silently repaired with a replacement meeting. Cancel and make a new booking if the pinned event/account cannot be restored.

## Collective selection and optional ordinary copies

Authenticated event-type details expose `conferenceOrganizer: {userId} | null`. A collective
Google Meet opt-in must explicitly select a current verified required host with an owned,
Meet-capable Google destination. Individual meetings use their one host; round robin rejects
a fixed organizer and uses the actual winner. Pool/mode/organizer edits are explicit and
validated; omitted metadata fields preserve the saved selection. Changes affect new roots.
The paged editor directory exposes member names and IDs, never private availability or email.

Only the organizer needs a Meet-capable Google calendar. Other required hosts retain normal
ICS invitations without connecting a calendar. Up to N−1 explicitly configured eligible Google
write destinations become ordinary private copies using the same ready URL and UID, without
`conferenceData`, create requests or provider attendee invitations. Round robin has no pool
copies. An absent destination is frozen as `not_configured`; configured unsupported/failed
destinations retain their distinct reason. Unknown database/programming failures propagate.
A future connection or destination change never adds or transfers a target to an old root.

Authenticated host booking/list responses optionally add `calendarCopy` for that caller only:
`{status: "pending"|"ready"|"failed"|"not_configured", errorCode, canRetry}`. They also provide
`conferenceCanRetry` for the pinned organizer. Public/manage/embed booking responses contain
neither field. No other host's target map, provider/account/calendar IDs or invitation address
snapshot is returned. The bilingual host page supports a bounded status check and an empty
strict JSON `POST /api/v1/bookings/{id}/calendar-copy/retry` for an existing pinned failed copy.
Unconfigured/unpinned targets cannot gain provider authority through retry. A ready conference
remains ready when a separate copy fails. Restore the original connection for cleanup; the
application never promises that cancelling an event revokes access to its Meet URL.

MCP `list_bookings` exposes the same caller-only state. `retry_conference({bookingId})` is
restricted to the current verified pinned organizer; `retry_calendar_copy({bookingId})` to
the current verified original host's own target. CLI `retry-meeting` and
`retry-calendar-copy` forward these strict objects. They never accept a management token,
replacement calendar, organizer or force-create flag. Public MCP/CLI booking retains the
normal teamSlug/handle namespace and idempotency contract.

Each ordinary copy has a durable operation identity, immutable provider pins, revision,
lease and bounded retry state. Claims commit before network; result application follows
booking → intent → target order after the credential transaction ends. Unknown acceptance
permits only known-ID/strict-UID reconciliation: an empty lookup never authorizes another
POST. A late valid ID survives a changed booking or expired/replaced lease and wakes safe
reconciliation if another worker had already reported ambiguous absence. Cancellation cleans
all discovered original targets, including late creates. Disconnected targets keep inspectable
failure evidence instead of disappearing. No network crosses booking/advisory/intent/target
locks. Background due scans recover work that ran before readiness or lost its queue job.

## Immutable invitations and published0021 compatibility

New automatic roots privately snapshot the selected host's verified Hourmere address and
bounded display name. This is the logical ICS ORGANIZER, not an additional recipient or a
claim about Google's account organizer address. OAuth `account_email` is display metadata;
it never proves an application address or authorizes a message recipient. Other hosts are
excluded from/added to ICS ATTENDEEs by identity, not by sort position. The selected organizer
is never duplicated as a host ATTENDEE.

REQUEST/reminders require that same selected host to remain a current verified member with
the exact pinned application email. An address change, departure, deletion or lost verification
stops new invitations and exposes `organizer_unavailable`; no other person/address takes over.
Delivery remains pending rather than pretending that a suppressed invitation was delivered.
Restore the original verified identity, contact the host, or cancel. CANCEL may retain the old
logical identity while physical host recipients are always their current verified addresses;
the old snapshot is never mailed host answers merely because it was stored. A removed or
unverified host receives nothing. Per-recipient checks and existing dedupe still apply.

Published0021 single-host roots have no trustworthy historical invitation address. Migration
0023 leaves both new snapshot columns null and preserves every old field, timestamp and
migration checksum; it never guesses a historical address or adds copies. Those roots retain
the reviewed current-verified-same-pinned-host REQUEST/CANCEL behavior, including a verified
address change. Without that trusted organizer they receive truthful no-ICS logistical notices.
This explicit compatibility exception lacks historical address continuity guarantees; the
stronger immutable invitation identity applies only to new roots. Existing valid roots are
not globally disabled or forced to rebook during upgrade.

## Privacy and acceptance limits

Google API calls use fixed official hosts, no redirects, bounded responses and safe event-ID path segments. Only a successful `hangoutsMeet` response with the expected HTTPS `meet.google.com/aaa-bbbb-ccc` video URL is accepted. Raw conference data, signatures/PINs, provider error bodies and privileged meeting-start URLs are not retained. Join URLs are protected location data, never public catalog metadata, webhook snapshots, logs, job payloads or browser persistence. Async enrichment emits no new booking transition and does not change activity analytics.

The migration is additive and does not activate old data. Automated validation uses fake Google/mail transports, helper-owned PostgreSQL and existing Chrome. These tests do not establish real account policy, consent or delivery acceptance. Actual Google consent/test events and Zoom app/account setup remain separately authorized operations; this slice does not claim live-provider acceptance or Zoom support.
