# User content direction

This inventory covers the rendering of user-entered names, titles, descriptions and
mixed-direction text. Each value resolves independently of the surrounding interface copy,
punctuation and other values.

## Interface direction

| Existing behavior | Observed value | Source |
| --- | --- | --- |
| Registered interface directions | `ltr` | [Locale registry](../packages/core/src/locales.ts) |
| Routing preview question label | `<bdi>` | [RoutingFormPreview](../apps/web/src/pages/routing-forms/RoutingFormPreview.tsx) |
| Routing preview event title | `<bdi>` | [RoutingFormPreview](../apps/web/src/pages/routing-forms/RoutingFormPreview.tsx) |

The [dashboard language switcher](../apps/web/src/i18n/runtime.tsx) and [public language
switcher](../apps/web/src/public/PublicLanguageSwitcher.tsx) take document direction from
the locale registry. The [embed widget](../apps/web/src/embed/widget.ts) sets the direction
of its own controls to `ltr`. The [booking preview](../apps/web/src/public/BookingPagePreview.tsx)
uses scoped language. The `.user-content` rules provide wrapping and sizing. Keep the
existing `<bdi>` boundaries in the routing preview, publication, rules and target editors.

## Browser rendering inventory

| Surface | Isolation boundaries |
| --- | --- |
| [Host profile](../apps/web/src/public/HostPage.tsx) | Isolate the profile name, organization name and event card title and description. In the empty state, isolate the name next to the translated copy. |
| [Team booking home](../apps/web/src/public/TeamHomePage.tsx) | Isolate the team and event names, give the public address its own LTR boundary, and resolve each description line independently inside the event link. |
| [Booking event info](../apps/web/src/public/BookingPageParts.tsx) and [description](../apps/web/src/public/EventDescription.tsx) | Isolate event titles, host or team names and custom locations. In the required-host list, isolate each name separately from zone names and localized separators. Put the description boundary inside its disclosure control. The same event info serves personal, team, embedded, one-time-link and draft preview flows. |
| [Booking confirmation](../apps/web/src/public/BookingPage.tsx) and [manage booking](../apps/web/src/public/ManageBookingPage.tsx) | Isolate each title or name in confirmation copy, host and guest lists, and cancellation summaries. Give names and adjacent email addresses separate boundaries. Isolate custom question labels, answers and notes where displayed. |
| [Booking form](../apps/web/src/public/BookingForm.tsx) and [waitlist](../apps/web/src/public/WaitlistJoin.tsx) | Apply automatic direction to free-text name and answer controls. Isolate custom labels and option copy where rendered, including question labels in linked error summaries. Leave localized hints and validation in the surrounding direction. |
| [Team members](../apps/web/src/pages/TeamMembers.tsx), [member actions](../apps/web/src/components/team-members/TeamMemberActions.tsx) and [space switcher](../apps/web/src/components/SpaceSwitcher.tsx) | Isolate display names and team names next to role, status and current-space labels. Include the name slots in role, removal and recovery dialogs. |
| [Profile settings](../apps/web/src/pages/Settings.tsx), [event list](../apps/web/src/pages/event-types/EventTypes.tsx) and [event editor](../apps/web/src/pages/event-types/EventTypeEditor.tsx) | Apply automatic direction to editable display names, titles and descriptions. Isolate titles in list rows and action labels where markup is available, and custom location and schedule names in editor summaries. Include [host assignment](../apps/web/src/pages/event-types/HostAssignment.tsx) names. |
| [Personal bookings](../apps/web/src/pages/bookings/Bookings.tsx), [booking detail](../apps/web/src/pages/bookings/BookingDetail.tsx) and [team bookings](../apps/web/src/pages/team-bookings/TeamBookings.tsx) | Isolate event titles, shown host and attendee names, and custom answers. Give generated booking titles separate name and event slots. Give verbatim historical and custom titles a single boundary, preserving the distinction in [booking title formatting](../apps/web/src/pages/bookings/booking-format.ts). |
| [Routing editor preview](../apps/web/src/pages/routing-forms/RoutingFormPreview.tsx), [public routing](../apps/web/src/public/RoutingFormPage.tsx) and [public poll](../apps/web/src/public/MeetingPollPage.tsx) | Cover form or poll titles, descriptions, custom questions, options and answers, plus routing messages. Apply the same pattern to voter names and event titles in [host poll results](../apps/web/src/pages/meeting-polls/MeetingPollResults.tsx). Keep routing on its existing rollout policy while testing with fixtures. |
| [Routing continuation](../apps/web/src/public/RoutingContinuationPage.tsx) | Isolate the event title and host name in its own booking header and confirmation. The shared description handles prose. |

## Rendering decisions

1. Wrap an unknown-direction inline value in `<bdi>`, or put `dir="auto"` on the
   element that contains only that value. The browser determines the base direction
   from the first strong character. Keep translated words, punctuation, counts and
   status labels outside that boundary. Preserve locale-specific ordering and Chinese
   spacing when rendering a localized message with separately marked-up placeholders.
   In lists, use `Intl.ListFormat.formatToParts` so each element can be isolated while
   conjunctions and separators stay in the surrounding context.
2. Put `dir="auto"` on content-only headings, prose blocks and free-text inputs or
   textareas. Keep labels, help, errors, buttons and layout wrappers in the interface
   direction. Give each logical paragraph of mixed-direction prose its own first-strong
   resolution. Verify the multiline presentation, blank lines and wrapping inside the
   existing booking disclosure in a browser before choosing the markup for that renderer.
3. Keep formatted dates, numbers, time zones, and IDs in their existing presentation.
   Where an email address, URL or handle runs directly beside a name and needs a separate
   boundary, isolate the displayed token using its known direction when applicable.
   Keep links, copied values and form values intact.
4. Preserve semantic headings and labels, focus handling and live announcements. Use
   existing visible text for `aria-labelledby` or `aria-describedby` when suitable. An
   accessible name can be flattened to a string, so verify announcement and reading order
   independently of visible isolation. Native text-only options use plain text and can be
   tested with `dir="auto"` on the option itself. Platform-dependent menu rendering and
   string-only surfaces such as tab titles and `aria-label` need separate verification.
   Record remaining string-only limitations without adding hidden controls to strings.

The interface language picker, account and browser preference logic, locale catalogues,
document direction, preview scope and embed chrome follow the current interface policy.
Keep the existing responsive layout, text wrapping and styles. The HTML Standard defines
[the `bdi` element](https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-bdi-element)
and [directionality](https://html.spec.whatwg.org/multipage/dom.html#the-dir-attribute).

## Data model and permissions

Direction is derived when rendering the already-authorized text. Existing records, inputs,
normalization, string lengths and validation rules remain the source of truth. Use escaped
React text and preserve all field projections. Display names are Unicode text. ASCII URL
handles keep their current rules, and each field keeps its existing control-character
policy. An embedded or one-time page receives the same subset as before. A manage link still
exposes only its own booking and a public group page still omits the attendee roster. Team
pages retain their existing organization and role checks. Fixtures use invented names and
booking details.

## REST, MCP and CLI

Existing operations continue to return and accept the same text, schemas and errors across
REST, MCP and CLI. The rendering work requires no parity registry entry or generated API types.

## Email and calendar files

HTML booking, invitation and poll emails isolate user-authored text inside the translated
message. A host's multiline follow-up or workflow message resolves one line at a time.
Displayed email and URL tokens have their own left-to-right boundary where they appear beside
names. Plain-text mail, mail subjects and calendar files carry their original text and
protocol escaping. The mail or calendar client controls direction when it displays those
strings. Browser tab titles, string-only accessible labels and native select menus likewise
depend on how the browser or platform presents their text.

中文：预约页面、管理后台和 HTML 邮件会按姓名、标题、说明等内容各自确定文字方向。
团队预约主页的活动说明逐行确定方向，活动编辑器的摘要分别隔离自定义地点和时间表名称。
界面仍按所选语言排版。纯文本邮件、邮件主题和日历文件保留原始文字，由客户端决定
显示方向。浏览器标签页标题、纯文本无障碍标签和原生下拉菜单由浏览器或平台呈现。

## Failure modes

| Case | Expected behavior |
| --- | --- |
| Empty, whitespace-only or punctuation/digit-only value | Keep the existing empty-value fallback. When the browser finds no strong character, use its native automatic-direction fallback within the content boundary. |
| Mixed names with quotes, brackets, numbers or other names nearby | Each name resolves within its own boundary. The UI retains its order and punctuation, including when changing interface language in place. |
| Long or multiline text | Preserve line breaks, wrapping and keyboard access to the description disclosure. Test the restored text after expanding and the layout at 320 CSS pixels. |
| Unknown or unavailable data | Keep the existing neutral loading, error and permission-denied copy. A direction change must not alter readiness, visibility or the team-space weekly-hours hint. |
| Existing directional controls in text | Follow the field's existing validation and storage rules. Isolation addresses interactions with surrounding UI, while the content's internal visual order still follows the browser's bidi algorithm. |

## Test plan

- The doc-fact test binds the current table to the locale registry and existing preview
  markup. It covers the inventory baseline.
- In the implementation passes, exercise Arabic-first, Hebrew-first, Latin-first and CJK
  text, punctuation-only values, leading emoji and digits, bracketed emails, and mixed
  paragraphs in the same view. Cover English and Simplified Chinese. Assert the markup
  boundary per value, exact rendered text, preservation of existing submitted and saved
  values, localized label and punctuation order, form labels, focus, and the existing
  document `lang` and `dir` policy.
- Check actual reading order, punctuation, native controls and description disclosure in
  Chromium and spot-check an additional supported browser and assistive technology. Include
  the preview and embed at 320 CSS pixels. Run browser automation in CI or with repository-
  approved escalation. jsdom assertions cover markup and state, while browser checks cover
  computed direction and visual order.
- Reuse existing permission and redaction fixtures for public booking, one-time and manage
  links and team booking reads. Check that list rendering, clip/disclosure behavior,
  accessible names and submitted values still match the existing behavior.

## Implementation steps

Each step fits one workday and carries its own regression checks. Split any step whose
implementation and verification exceed that window.

| Step | Scope | Acceptance |
| --- | --- | --- |
| Day 1 | Host profile, shared booking header and description, embed and draft preview | Titles, names and paragraphs have independent direction. Required-host separators and controls follow the interface. The description still expands and restores blank lines. |
| Day 2 | Booking and waitlist forms, confirmation and invitee management | Name, email, title and punctuation remain distinct. Free-text fields keep existing submission and normalization behavior. Invitee visibility and link capabilities stay within existing projections. |
| Day 3 | Dashboard profiles, team people and dialogs, event editor, and booking lists and detail | Names, titles and questions isolate from roles and statuses across the dashboard; localized labels, keyboard focus and readiness behavior are preserved. |
| Day 4 | Routing including the continuation and confirmation, polls, and cross-surface browser acceptance | Custom labels, answers and messages resolve on their own. Verify locale direction, access boundaries, mobile wrapping and mixed punctuation across the representative flows. |
