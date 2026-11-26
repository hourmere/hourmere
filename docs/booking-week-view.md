# Optional week view for public booking

This is a design and cost evaluation. Hourmere currently opens the month calendar
and lists available times for the selected day. A week view would let invitees compare
start times across several days before choosing one. In the October 26, 2026 owner
comparison, SavvyCal opened on a weekly grid and Cal.com offered week, month and list
layouts. The comparison put this option last among the proposed UI improvements.
Both vendors document their layout choices. [SavvyCal booking pages](https://docs.savvycal.com/what-schedulers-see-on-your-booking-page)
 · [Cal.com booking layouts](https://cal.com/blog/enhanced-flexibility-take-advantage-of-cal-com-s-multiple-booking-layouts)

## Layout and interaction

- The page opens in **Month** on every visit. For an enabled event and a wide enough
  picker, show a labelled **Month / Week** radio group above it. The month keeps its
  day calendar, day time list and navigation. The week uses the space of those two
  panels for seven day columns, with the visitor's locale determining which day comes
  first. Keep the event details, duration choices and time zone control in their
  existing places relative to the picker.
- Use a date-range heading with **Previous week**, **This week** and **Next week**.
  Render a row for each local start time with a bookable slot somewhere in the week.
  Align matching starts across days, use a time gutter and leave gaps where options
  are absent. The rows show start options, so two offered starts can overlap in
  duration without overlapping buttons. Keep all seven day headers and label days
  with zero times. Limit selectable dates to today through the last day of the last
  month reachable in Month. Keep all seven columns in the first and last weeks,
  label out-of-range dates as unavailable, and keep an empty week visible so the
  invitee can page deliberately.
- Switching to Week opens the week containing the selected day, or the current
  month calendar's focus date if no day is selected. Switching to Month opens the
  month of the last focused or selected slot's local date, with that day selected if
  it has times. Without either, use the first in-range date of the displayed week,
  which is today in the current week. Preserve the chosen duration and visitor time
  zone. A date or focused slot alone never advances the flow.
- Clicking or activating a slot opens the existing details step. **Change time**
  restores the layout, week and originating slot focus if it still exists. A stale
  slot or removed duration returns to the picker with the current availability
  message and keeps entered details. Apply the existing direct-slot validation
  before showing either picker. A valid direct-slot link leads to details, and an
  invalid or taken suggestion leads to the normal Month fallback. The final
  confirmation rechecks ordinary booking rules. [Suggested times and duration changes](multiple-durations.md)
- For waitlist-eligible events, provide a Month action from a successfully empty
  Week. Carry the first in-range date into Month as the selected day even when
  it has no slots, and treat the switch as explicit navigation so Month stays
  there. Let the existing successful-empty day rule decide whether to offer
  enrollment for that date. A failed fetch cannot establish that a week is empty.

### Narrow screens and embeds

Use the picker container's available width. Start the prototype at 720 CSS px
for the time gutter and seven readable columns, then set the final threshold
from translated labels, zoom and touch measurements. Give the picker the full
content row if the details panel would otherwise squeeze it. At narrower sizes,
use the existing Month date-then-time flow, including at 320 CSS px. Omit the view
selector when only Month is available. When resizing out of Week, transfer the
active local date to Month and move focus to its day control or picker heading if
the focused control disappears. Widening the container leaves the visitor in Month
until they choose Week again. Keep a booking form open if the viewport changes.

Proposed first scope is standalone personal and team events in individual booking
mode, including collective and activated round robin. Use the existing month flow
for group events, embeds at any width, one-time links, routed continuations,
waitlist capability links and rescheduling. These paths share picker or form
components and have their own controls or capability semantics. Keep the host's
draft preview on sample availability.

## Keyboard and screen readers

Use a named `grid` with `row`, `columnheader`, `rowheader` and `gridcell` semantics.
Give each available slot a real button and use roving `tabindex` so the grid has one
Tab stop. Set `aria-colcount` to eight including the time gutter, and use consistent
`aria-colindex` values for sparse rows. Keep DOM order aligned with visual order.
Empty intersections have no control and receive no focus. The day headers and
a concise summary outside the grid expose dates with no openings.
Each button's accessible name includes the full date, local time and zone, with
the UTC offset when labels repeat. Associate the grid with its date-range heading
and a short keyboard hint. [WAI-ARIA APG grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)

| Input | Behavior |
| --- | --- |
| Tab / Shift+Tab | Enter at the restored slot or first available slot. Leave the grid in either direction. |
| Up / Down | Move to the previous or next available start that day in chronological order. |
| Left / Right | Move to the nearest day with slots in that direction, choosing the same local row if available, then the nearest time with earlier starts breaking ties. Keep focus at the edge. |
| Home / End | Move to the first or last available slot in the current row. Control+Home and Control+End move to the grid's first or last slot in reading order. |
| Enter / Space | Activate the focused slot and focus the existing details heading. |

The left/right gap behavior is specific to this sparse grid. Tell invitees that
the arrows move between available times and leave week paging to the toolbar.
Keep focus on the paging or view control when it changes the results. If a
refresh removes a focused slot, restore the same instant if possible, then the
nearest available slot on the same day, then the first slot in the week. If there
are no slots and grid focus would otherwise be lost, move it to the week heading
using `tabindex="-1"` or to the retry control on failure. Scroll the focused control
into view and keep its outline clear of any sticky header.

Keep a single polite status mounted for the loaded week range and available count,
loading, empty and error transitions. Place the heading, navigation and retry
outside the grid. Show no empty grid as a keyboard target. Give visible and announced
names to controls and distinguish available times and focus through borders,
text and outlines in light, dark and forced-colors modes. Reuse booking tokens,
keep normal text at 4.5:1 and control/focus indicators at 3:1 or better, and retain
the existing 44 CSS px coarse-pointer targets. Availability and selection must
remain legible without color or hover.

Provide English and Simplified Chinese strings for all controls, instructions,
announcements and errors. For example, **Booking view / 预约视图**,
**Month / 月视图**, **Week / 周视图** and **Next week / 下一周**. Use the existing
public catalogue and fallback rules for German, French, Spanish and Brazilian
Portuguese. Localize date ranges, plurals and 12/24-hour labels through the existing
formatting locale. [Interface language rules](../apps/site/src/content/docs/docs/interface-languages.md)

## Slot loading, time zones and performance

- Reuse the personal and team public `/slots` reads and their existing selected
  duration and applicable location inputs. Request the displayed week's in-range
  starts while Week is active. The server continues to decide which slots fit
  host availability, notice, buffers, booking limits and team scheduling rules.
  Render returned availability only. The public grid needs no attendee,
  busy-calendar or host assignment details.
- Compute the first local date of the week in the invitee's selected IANA zone.
  Add seven **calendar** days for the next week's first local date, using the
  existing date and `Intl` helpers. Convert both boundaries to instants using
  local start-of-day semantics. Set the start to the later of the first boundary
  and now. Set the exclusive end for slot starts to the next boundary, capped
  in the final week at the start of the day after the last permitted date. Add
  the selected duration to the end sent to the API since it returns fully contained
  intervals. A meeting starting on the final day can finish in the following week.
  Filter starts to the unpadded interval and group by their local date. A
  daylight-saving transition can shorten or lengthen the interval, so elapsed-hour
  arithmetic is unsuitable for paging.
- Use the returned start instant as slot identity. Omit nonexistent spring-forward
  times. Show repeated fall-back starts as separate rows in chronological order
  on the affected date, with the offsets visible and spoken. Changing the zone
  re-anchors the week on the focused instant's new local date when there is one,
  or preserves the anchor date when there is none, and recomputes the range.
  A language change relabels the display. If the first weekday changes, recompute
  the week around the same active date. Each control preserves a selected instant.
- Keep one active range load for the visible picker. Key it by public event
  identity, exact range, zone, duration and applicable location, plus the refresh
  generation. Abort superseded requests and discard late results. Deduplicate
  concurrent loads for the same key in memory. Start with no speculative week
  prefetch or persistent slot cache. Refresh after returning from details,
  conflicts and explicit retries. Reuse the existing bounded `range_too_long`
  split with duration overlap and start deduplication. A week can still exceed
  the candidate-work limit for a short step across several hosts. Treat a failed
  split or a rate limit as a retryable error for the range and honor
  `Retry-After` when present. [Existing slot loader](../apps/web/src/public/api.ts)
- Measure request count, bytes, response latency and time to interactive slots
  for identical sparse, ordinary and dense synthetic events in both layouts.
  Aim for one range request per ordinary displayed week and zero extra range
  requests or eager Week JavaScript on Month entry. Track DOM size, render time
  and keyboard response on throttled hardware. A one-minute step can yield
  thousands of buttons even in a week. Determine a render budget in the prototype
  and offer an explicit Month action if a range exceeds it, keeping all slots
  reachable there. Keep displayed slot counts separate from any rendering budget.
  The proposed first iteration needs no calendar library or new runtime dependency.

## Configuration options

| Option | Effect and cost |
| --- | --- |
| **Per event type** | Recommended. An off-by-default **Offer week view / 提供周视图** setting in the event editor lets a personal owner or current team owner/admin enable the visitor switch for a specific link. Existing and newly created types start off. Reuse event-edit organization and permission checks, expose only the eligibility boolean in public event metadata, and keep Month first even when enabled. Budget for storage, migration and coverage, generated types, editor and sample preview, and existing event-type API, MCP and CLI parity. |
| **Per host user** | A profile default is convenient for many personal links. As a default for creating new types it adds settings UI and copy-on-create behavior. Inheriting it at read time could change live links together and would require a separate ownership rule for collective and round-robin events. Estimate another one to two days for the new-type default after the event-level setting. Live inheritance needs a separate estimate once ownership and override rules are decided. |
| **Visitor only** | Show the switch on all eligible wide booking pages. Keep the current view choice in memory for the visit, as in the event-level proposal. This saves the storage and editor work but gives hosts no link-level control. Signed-in visitor preferences would cover only a subset of public invitees. |

## Test plan

| Area | Acceptance checks |
| --- | --- |
| Date and range | Locale week starts, month/year crossover, UTC and zones on opposite sides of midnight, DST gap and fold, a half-hour transition and a midnight transition. Assert request bounds and compare Week's in-range starts to the same dates in Month with the same clock and fixture, including long meetings on the final day and starts crossing a split boundary. Check chronological repeated starts, their offsets and absence of duplicate or overflow starts. |
| State and requests | Both switches with a selected and unselected day, empty weeks, navigation limits, rapid paging with out-of-order responses, zone and duration changes, 429 and retry, and density fallback. Check one ordinary range call per week, no extra Month reads, and neutral loading or error text. |
| Booking and configuration | Month is first when enabled and the only choice when off or excluded. Verify the same instant and duration reach details and confirm, conflict refresh preserves the form, and Change time restores focus. Cover personal and team permissions, cross-space denial, existing rows defaulting off, collective and round-robin availability, direct links, and existing group/one-time/routed/reschedule/embed paths. Test the waitlist handoff from an empty week in a month with openings elsewhere. |
| Responsive and accessibility | Extend the booking layout and axe matrices for Week and its Month fallback at 320 px, the container threshold, and desktop. Cover en and zh-CN, regional English formatting, light/dark, forced colors, text expansion and zoom. Assert focus order, visibility, 44 px touch controls and no page overflow. Validate the arrow rules, empty/error announcements and form focus with NVDA/Firefox and VoiceOver/Safari, plus narrow touch use on real devices. |
| Baselines and performance | Keep the Month fixtures as comparison points. Add distinct Week and narrow fallback layout/axe states because they exercise a new grid and the breakpoint. If visual PNGs are in use, review masked Linux baselines for those new states. Justify any changed existing baseline with the intentional visible difference. Run the request and rendering measurements above before enabling the switch for a pilot. Keep existing CI time limits. |

Use the repository's existing component tests and browser fixture and audit
workflow. Axe cannot verify spoken labels, focus restoration or keyboard traversal
on its own. [Responsive, accessibility and visual measurements](../CONTRIBUTING.md#responsive-accessibility-and-visual-measurements--响应式无障碍与视觉检测)

## Estimate and recommendation

Estimate **six engineering days** for a per-event opt-in pilot with the scope
above. The estimate assumes reuse of the existing slots and booking flows and
includes acceptance work. The visitor-only option saves day 4, for five days.
If densest fixtures or assistive-technology testing require a new rendering or
focus approach, allow one or two additional days before pilot acceptance.

| Day | Deliverable |
| --- | --- |
| 1 | Prototype the seven-day layout with representative labels and density. Confirm the container threshold and test the sparse grid's focus model with a screen reader. |
| 2 | Implement local week ranges, request lifecycle, DST labels and range/split tests. Compare request size and count against Month. |
| 3 | Wire the two layouts to the shared booking and focus state. Cover responsive fallback, form return, direct links, errors and localized messages. |
| 4 | Add the event opt-in with existing edit permissions, default-off migration coverage, metadata, generated types, editor and preview, and event-type client parity tests. |
| 5 | Add browser acceptance, responsive and axe coverage, and review baseline diffs and performance fixtures. |
| 6 | Verify keyboard and screen-reader behavior on the browser/device matrix. Fix acceptance findings and document host enablement and invitee behavior. |

**Recommendation.** Defer implementation until hosts report a recurring need to
compare times across days. If that need is confirmed, run the one-day prototype
first. Proceed with a per-event, default-off pilot only if it preserves Month's
entry performance and passes the keyboard, screen-reader and density checks.

**Questions for the owner**

1. Which hosts or booking scenarios would justify a pilot, and what improvement
   in finding a time would count as success?
2. Should the pilot include collective and activated round-robin events on day
   one, or begin with only single-host events?
3. Is a per-event opt-in enough, or do hosts need a default for newly created
   personal events?
4. Is Month an acceptable fallback for phones, dense weeks and waitlist enrollment,
   or is any of those cases part of the pilot's core use case?
