# Desktop cross-engine regression

Local run on 2026-11-28 with Playwright 1.64.1 on macOS 27.2.1. The table reports
headless desktop Firefox 157.0 and Playwright WebKit 27.2 at 1280 × 720. Playwright
WebKit provides desktop engine coverage. Safari and iOS devices were outside this run.
All 24 test instances passed, 12 per engine, in 2.8 minutes with one local worker.

| Flow | Browser assertion | Firefox | Playwright WebKit |
| --- | --- | --- | --- |
| Password sign-in | A synthetic user signs in at loopback Keycloak and returns to a verified Hourmere session via OIDC. | PASS | PASS |
| Magic-link sign-in | Existing and new accounts confirm a link from fixture mail and get a real session. | PASS | PASS |
| Onboarding | A new user saves their profile, creates default availability and a first event type, and selects a slot on the resulting booking page. | PASS | PASS |
| Create and edit event type | The editor creates an event, saves timing changes and verifies persisted values. | PASS | PASS |
| Public booking and time zone | An anonymous invitee switches from UTC to Tokyo, books, and sees Tokyo in the confirmation. | PASS | PASS |
| Attendee reschedule | The confirmation's attendee link opens management, scrubs the URL fragment and moves the booking. | PASS | PASS |
| Attendee cancel | The attendee cancels the moved booking. Both records end in the expected state. | PASS | PASS |
| Team round-robin | An owner saves and activates a pool. Two public bookings rotate hosts, and rescheduling retains the assigned host. | PASS | PASS |
| Routing form | A public submission books a routed event and saved answers remain private on unrelated surfaces. | PASS | PASS |
| Embed widget | The cross-origin popup books, limits data sent to its parent, and restores focus after Escape. The settings case also loads an inline widget. | PASS | PASS |
| Admin settings save | The team administrator saves name and address changes and verifies their effect on public links. | PASS | PASS |
| Language switch | The admin interface switches between English and Simplified Chinese and preserves the draft and localized validation. | PASS | PASS |
| Protected-page redirect | A signed-out visit to account settings lands on sign-in. | PASS | PASS |
| Event-type table | Long booking links truncate within the table while keeping the title and copy button readable. | PASS | PASS |
| Host slot copy | The host copies complete plain and rich snippets and stale alternatives prevent a partial copy. | PASS | PASS |

CI runs tagged cases in four parallel shards. Each shard keeps the existing 25-minute
limit and one worker for system clipboard isolation. The `e2e-cross-engine` check
requires all four shards to succeed. See [local commands](../CONTRIBUTING.md#responsive-accessibility-and-visual-measurements--响应式无障碍与视觉检测).

The first WebKit run found that its visibility API kept reporting controls hidden
after an event settings disclosure opened. Hiding the closed `::details-content`
preserves zero-height closed controls and lets WebKit recognize the revealed controls.
The editor flow checks both states before saving. On this Mac, the pinned Firefox
also needed a temporary `CFFIXED_USER_HOME` to launch. [Playwright issue #42768](https://github.com/microsoft/playwright/issues/42768)
