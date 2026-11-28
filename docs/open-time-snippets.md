# Share available times in email

Hourmere can format several alternatives for one meeting as a list of direct booking
links. Your instance operator must enable `SLOT_SNIPPETS_ENABLED`, which defaults to
`false`. For email use, set `PUBLIC_URL` to the instance’s public HTTPS address.

## Pick and paste in the browser

1. Open an active saved event type in **Event types** as its personal owner or as an
   owner or administrator of its team. Under **View and share**, click **Pick open
   times**. Save edits first and activate round-robin events before sharing.
2. Set **Meeting length**, **Email language** and **Display time zone**. Pick 1–10
   options under **Available times**, using **Availability date** to pick across days.
   Changing the length clears the selected times.
3. Click **Preview email**, then **Copy rich text** for linked time labels or
   **Copy plain text** for a label and full URL on separate lines. If clipboard
   access fails, select and copy the complete plain-text preview. If a selected time
   is marked **No longer offered** during the copy check, remove it, choose a
   replacement if needed, and preview again.
4. Paste into your email draft and keep the availability notice.

Recipients see the title, meeting length, proposed dates and times, time zone, and
UTC offsets. When a recipient clicks a link, Hourmere opens the booking page in their
own time zone and language. The linked time opens selected if it is still available.
The recipient fills in the booking form and confirms. If that time has been taken,
the page explains that it is unavailable and shows the regular time picker.

## Generate the same snippet with REST, MCP or CLI

The example requests 30-minute alternatives during a week in Los Angeles. The start
and end have different UTC offsets because the clocks change during the week. The
email labels use Shanghai time. Replace the slug, dates and length with an active
event, a future range and an offered length, then save the JSON as `snippet-request.json`.

```json
{
  "slug": "intro",
  "from": "2027-03-08T00:00:00-08:00",
  "to": "2027-03-15T00:00:00-07:00",
  "count": 3,
  "displayTimeZone": "Asia/Shanghai",
  "locale": "en",
  "durationMinutes": 30
}
```

For REST and CLI, set `HOURMERE_URL` and `HOURMERE_API_KEY` in your private environment.
A `read`, `bookings` or `full` API key works with the same event permissions as the
dashboard. MCP also accepts an authorized OAuth connection.

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/open-time-snippets" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @snippet-request.json

hourmere open-time-snippet --json --input snippet-request.json
# From the source checkout:
npm run --silent cli -- open-time-snippet --json --input snippet-request.json
```

For MCP, call `generate_open_time_snippet` with that same JSON object as the tool
arguments. The REST schema appears in `/api/v1/openapi.json` on your instance. A
successful response includes `bookingUrl`, `durationMinutes`, `locale`,
`displayTimeZone`, `slots` (each with `start`, `end`, `label` and `url`), `text`
and `html`. Use `text` in a plain-text draft or `html` as formatted content.

## Limits

- Supply exactly one of `eventTypeId` (a UUID) and `slug` (unique in the acting
  organization). The API accepts an inclusive `from` and exclusive `to` as RFC 3339
  instants spanning at most 31 elapsed days. It returns the earliest available starts,
  up to `count` (1–10, default 3). A range can return fewer times, and overlapping
  alternatives or multiple starts on one day are possible.
- If omitted, the display time zone and language use profile settings with UTC and
  English fallbacks. The duration defaults to the event type’s default length.
- Generating or copying a snippet creates no reservation and sends no email. A
  forwarded link can still open an unlisted active event. Send a fresh snippet if
  availability has changed since you drafted the email.
- REST returns `409 no_available_slots` if no times fit and
  `409 calendar_sync_unavailable` if a host calendar is temporarily unavailable. Try
  another date range for the first error or retry after a short wait for the second.

See [Share available times in email](https://hourmere.com/docs/open-time-snippets)
for disabled-feature responses and the full request reference.
