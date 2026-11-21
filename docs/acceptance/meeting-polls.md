# Meeting poll acceptance

The [meeting poll implementation plan](../meeting-polls.md#implementation-plan-and-acceptance-checks) calls for acceptance with fake providers and multiple time zones. These tests use migrated throwaway PostgreSQL databases, fake Google Calendar and captured mail. They exercise America/Los_Angeles, Asia/Shanghai and Europe/London, with an additional half-hour transition in Australia/Lord_Howe.

The targeted Vitest run passed 113 tests. The focused deadline run passed its three selected tests, including the source-copy check. Playwright passed both the desktop and mobile projects at 320 px.

## Workflow and privacy

| Check | Test | Result |
|---|---|---|
| Vote to booking over REST, MCP and CLI | [Transport acceptance](../../apps/server/src/meeting-poll-transport-acceptance.test.ts), “crosses REST, MCP and CLI” | REST creates the poll, MCP invites, voters verify and vote across the three adapters, and MCP and CLI finalize the same request. PostgreSQL records one booking and the selected attendees. |
| Guest limit | Same transport test | One booker and eleven guests are refused without claiming a slot. One booker and ten guests are accepted. |
| UI and anonymous 320 px voting | [Browser acceptance](../../tools/e2e/specs/meeting-poll-acceptance.spec.ts), “creates, verifies, votes across three zones and schedules a poll from the UI” | The host creates and schedules in the dashboard. A signed-out voter opens the actual verification mail, navigates the stacked ballot by keyboard, gives consent and sees the read-only scheduled result. |
| API key and OAuth scopes | Transport acceptance and [MCP OAuth](../../apps/server/src/mcp-oauth.test.ts), “binds meeting poll finalization and replay” | A read key can read results but cannot vote or finalize. A bookings key can write under host authority. MCP OAuth checks the organization and current `mcp:tools` consent, including on replay. REST rejects the MCP access token. |
| Source, tokens and voter information | Transport, OAuth, browser, [host adapter parity](../../apps/server/src/meeting-poll-host-parity.test.ts), [public contract diagnostics](../../apps/server/src/meeting-poll-public-contract.test.ts) and [SMTP outcome](../../packages/notifications/src/meeting-poll-outcomes.test.ts) checks | Host metadata preserves the booking source (`web`, `api` or `mcp`) and public projections omit source, attribution and other voters. Responses and diagnostics omit credentials outside their one-time or recipient-specific disclosures. Browser requests and referrers carry no poll credential. Credential mail uses recipient-specific fragment links, and the booking management capability reaches only the booker. |
| Reminder and deadline audiences | [Reminder](../../packages/notifications/src/meeting-poll-reminders.test.ts) and [deadline](../../packages/notifications/src/meeting-poll-deadline.test.ts) suites | A nonresponding invitee can receive one usable reminder at full capacity. Voted, withdrawn, removed, opted-out and unverified public voters are excluded. One deadline notice reaches the still-authorized creator and omits voter details. |
| Booking and outcome audiences | SMTP outcome suite, “delivers ordinary mail and localized outcomes” and “follows reschedule and cancellation” | Selected attendees and the host receive normal booking mail. Eligible non-attendees receive localized informational mail without a join link, booking management link or calendar attachment. Pending public, withdrawn and removed voters are excluded. The worker deduplicates delivery. |
| Concurrent finalization and booking | Transport acceptance and [finalize concurrency](../../packages/scheduling/src/meeting-poll-finalize-concurrency.test.ts) and [booking contention](../../packages/scheduling/src/meeting-poll-finalize-booking-race.test.ts) suites | A stale result revision cannot schedule. Two exact requests yield one commit and one replay. Different keys, competing ballots and an ordinary booking are covered by the lock-contention checks. |

## Time and lifecycle

| Check | Test | Result |
|---|---|---|
| Spring-forward gap and half-hour transitions | [Host deadline tests](../../apps/web/src/pages/meeting-polls/MeetingPollCreate.test.tsx), “resolves deadlines around the Los Angeles spring change and Lord Howe half-hour changes” | Missing wall times yield no instant. Lord Howe’s repeated half hour resolves to both UTC instants. |
| Both fall-back offsets and elapsed duration | [PostgreSQL time acceptance](../../packages/calendars/src/meeting-poll-time-acceptance.test.ts), “keeps both fall-back candidates distinct” | Two offered instants map to the repeated 01:30 in Los Angeles with different offsets and keep distinct slot IDs. Availability for a Los Angeles host offers the earlier occurrence on its local grid. A booking that starts there runs for 30 elapsed minutes through the clock change. |
| Zones on opposite sides of midnight | Browser acceptance, three-zone ballot | Changing the display zone changes local day labels and keeps each choice attached to its original candidate. |
| Host all-day busy interval | PostgreSQL time acceptance, “rechecks a synced all-day event” | An all-day date synced from a Shanghai calendar blocks the Los Angeles host’s 25-hour day. Create refuses its first and last slots. Finalize rechecks the conflict, and the following local midnight remains bookable. |
| UTC equality and a lock wait past the deadline | [Ballot tests](../../packages/scheduling/src/meeting-poll-ballots.test.ts), “treats the exact deadline instant as closed” and “refuses writes that waited on the poll lock across the deadline” | Voting is allowed one microsecond before the deadline and closed at equality. A transaction queued before the deadline is refused when the lock releases after it. |
| PostgreSQL fractional-second rounding | PostgreSQL time acceptance, “applies PostgreSQL microsecond rounding” | Rounded UTC timestamps drive the availability check and receipt fingerprint. Candidates that round to the same instant are rejected. Equivalent rounded input replays, while a different stored microsecond conflicts. |
| Lifecycle replay and updates | Transport acceptance, “replays create, rotation, close and cancel” and SMTP outcome suite, “follows reschedule and cancellation” and “drops queued poll mail” | Replays after rotation, closure, cancellation and deletion do not disclose the voting link again. An exact finalize retry returns the current booking after both rescheduling and cancellation, with no duplicate notices. Deleting a scheduled poll makes its finalize receipt inaccessible and preserves the booking. |

## Source-copy checks

| Guard changed in a copy | Observed failure |
|---|---|
| Treat deadline equality as open in the [voter service](../../packages/scheduling/src/meeting-poll-voters.ts) | The existing source-copy check passed by detecting the deadline equality `AssertionError`. |
| Add an action link to informational [outcome mail](../../packages/mail/src/meeting-polls.ts) | The copied SMTP outcome test exited 1 at `outcome has no invitation or action link`. The production renderer stayed intact. |
| Ignore a stale results revision in [finalize](../../packages/scheduling/src/meeting-poll-finalize.ts) | The transport test exited 1 when finalize returned 201 instead of 409 `poll_changed`. The guard was restored before the clean run. |

## Release blockers

The automated checks found no release blockers. The project lead owns final acceptance and the release decision.
