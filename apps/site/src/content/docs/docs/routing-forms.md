---
title: Routing forms
description: Publish a form that sends invitees to an event or shows a message based on their answers.
draft: true
---

A routing form asks questions before booking. It uses the answers to offer a booking for
one event or show a plain-text message. Personal space owners manage their own forms.
Current team owners and admins manage forms in their team space.

## Availability and the operator setting

Routing forms are hard-off in releases that precede the operator setting. Setting
`ROUTING_FORMS_ENABLED` in those releases has no effect. After the setting ships,
set `ROUTING_FORMS_ENABLED=true` on a self-hosted instance and restart the server to
enable routing. When the setting first becomes available, an unset or empty value
defaults to `false`. The setting accepts `true` or `false`. Other values fail startup.
For Docker Compose, set it in your deployment environment or deployment `.env` file,
then recreate the application service with the new configuration.

Self-hosted Hourmere and Hourmere Cloud have the same routing features and limits, with no
paid tier required. Hourmere operates the setting on Cloud. On either deployment,
`GET /api/v1/instance` reports the effective state as `routingFormsEnabled`. Follow the
steps below when it is `true`.

### Resolve a legacy handle collision

In releases with the operator setting, a stored personal handle of `route` in any case
keeps routing off and triggers a startup warning. Existing booking pages under that
handle keep working until the owner renames it. Team slugs live under `/team/` and can
keep the name `route`.

Coordinate the rename with the owner. Have them choose an available **Handle** in
**Settings** under **Profile** and select **Save profile**. Update shared personal
booking links and embeds to use the new handle. Restart the server and check
`routingFormsEnabled` again. New personal handles cannot use `route`.

### Turn routing off

In a release with the setting, set `ROUTING_FORMS_ENABLED=false` and restart the server
or recreate the Compose service.
Forms, drafts, published versions and enabled states are kept. The app hides **Routing
forms** and the public form links stop serving forms. Pending continuation tokens keep
their original expiry and cannot be used while routing is off. An unexpired token can
work again after re-enabling. Keep the original link if you need to resume. The page
clears the token from the address bar even when opened while routing is off.

Existing bookings, private manage links and saved routing answers remain available to
the people who already have access. Receipt cleanup and target-health checks continue.

The OpenAPI document and generated API key scope tables still list routing operations.
The CLI still shows the commands in its help. After transport checks, routing requests
return `routing_forms_disabled` (HTTP 404 over REST). MCP `tools/list` omits all eleven
dedicated routing tools. Calling one directly returns `routing_forms_disabled`.
`create_booking` stays listed for callers with booking access. An exact authorized retry
of a committed routed booking still returns the booking. For interface examples, see
[Routing forms for agents and integrations](/docs/routing-forms-api).

## Create and publish a form

1. In the correct personal or team space, open **Routing forms** and choose **New routing
   form**. Enter a title and a **Form address**. Add short-text, email or single-choice
   questions and choose which are required. Select **Save draft**.
2. In **Routing rules**, add the destinations and conditions. All conditions in a rule
   must match. The first matching rule wins. Set a **Fallback** for submissions that
   match no rule. A rule or fallback can select an event type or show a plain-text
   message.
3. If an event should receive answers as booking prefill, map each source question to a
   compatible booking field. For a single-choice mapping, map every form option to a
   current booking option. Invitees can edit the prefill before booking.
4. Select **Save draft**. In **Preview saved draft**, enter sample answers and select
   **Run preview**. Check both the matched rule and the destination used. Try the
   fallback as well.
5. Select **Review publication** and check the saved fallback. Select **Publish version**.
   Publishing keeps the current enabled state. A new form starts disabled. Choose
   **Re-enable routing form** and confirm to start accepting submissions.

Share `/route/{handle}/{slug}` for a personal form or `/route/team/{teamSlug}/{slug}` for
a team form, using your instance's public origin. The slug is the value of **Form
address**. If you change it, replace shared links. Saved title and description edits
appear on the public form immediately. Changes to questions, rules, mappings and fallback
take effect when you publish a new version.

Choose **Disable routing form** to pause submissions and block pending booking links
while the form is disabled. Re-enabling uses the current published version. Choose
**Archive routing form** to remove the form from the list. Archiving keeps the address
reserved and preserves answers already saved with bookings.

## Targets and booking links

Select an active event type from the same space. A team event can keep its single host,
round-robin pool or collective hosts. The event controls host selection and availability.
Group bookings, paid bookings and external redirect targets are unavailable.

Listed and hidden event types both work as targets. Publishing leaves the event's
visibility as it was. For a hidden target, a matching invitee sees the selected event's
booking details through the continuation. The public form metadata omits rules,
destinations and mappings. The continuation omits the reusable booking address and host
pool. Anyone who already has the event's normal direct link can still book through it.

If the matched rule's event is no longer eligible when the invitee submits, the form
tries the fallback. If that destination is also unavailable, the invitee sees an
unavailable message. A lack of open slots leaves the invitee on the selected event.
To repair an unavailable target, open **Published target health** in the form editor.
Use **Repair fallback** or the rule's repair button, change the destination, then save,
preview and publish. **Health unknown** means the app could not check the target.

The invitee submits the form and sees either a message or a booking page. If the
questions change during the visit, the page reloads the form and asks the invitee to
review their answers. On the booking page, pick a time, review the editable details and
confirm. Editing the prefilled details leaves the routing answers and selected event as
they were. To change routing answers, start again from the form.

Treat the continuation link like a password. Its token lasts 30 minutes from submission.
Reading booking details or checking slots leaves the expiry unchanged and reserves no time.
Only a successful booking uses up the token. If the token expires, has been used, or its
target is no longer eligible, start again from the original form. The continuation stays
on the booking flow and ends at confirmation, with no after-booking redirect or waitlist
option.

## Retention and export

A message result stores no answers. When a submission yields a booking link, Hourmere
encrypts the answers while waiting for booking. Form managers cannot list or export
these pending answers. Unbooked answers become inaccessible at expiry and are usually
purged within 24 hours after expiry. Cleanup can take longer during an outage. Rotating
`BETTER_AUTH_SECRET` makes pending answers unreadable. Invitees then start again from
the form.

On booking, Hourmere saves the original routing answers separately from the final
booking responses. Authorized hosts see the snapshot in booking detail. The invitee can
see their own snapshot with the private manage link. The snapshot follows booking
retention and survives form archive and booking reschedule. Routing adds no answers to
email, calendar copies, webhooks or analytics. Mapped booking responses follow the
usual rules for booking data.

Personal owners can open **Bookings**, expand **Export bookings as CSV** and select
**Include routing form answers**. The option starts unchecked and is available only
while routing is enabled. It adds saved form and rule details plus a `routing_answers`
JSON column. Team booking exports and team administrator booking views omit routing
answers. The export can contain personal data, so store and share it carefully. See
[CSV booking export](/docs/booking-export).

## Limits

| Item | Limit |
| --- | --- |
| Forms per space | 100 non-archived, including disabled forms. 1,000 retained, including archived forms. |
| Published versions | 1,000 retained per form |
| Questions and choices | 20 questions per version, 50 options per single-choice question |
| Rules and conditions | 50 rules per version plus the fallback, 10 conditions per rule |
| Text | 200 characters for titles and labels, 500 for text and email answers, 2,000 for descriptions and messages |
| Submission body | 64 KiB of JSON |
| REST request rate | 10 submissions and 120 continuation detail or slot requests per client per minute per server process |
| Pending booking links | 100 per form and 10,000 per instance across server processes. Only unexpired and unused tokens count. |
