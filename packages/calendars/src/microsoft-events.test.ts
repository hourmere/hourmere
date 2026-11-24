import { describe, expect, it, vi } from 'vitest'
import { createMicrosoftCalendarClient } from './microsoft.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'https://hourmere.test',
}
const calendarId = 'AAMkAGViNDU7zAAAAAGtlAAA='
const collection = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`
const transactionId = '7E163156-7762-4BEB-A1C6-729EA81755A7'
const booking = {
  transactionId,
  title: 'Private consultation',
  start: new Date('2030-03-10T01:45:00-05:00'),
  end: new Date('2030-03-10T03:15:00-04:00'),
}

// Shape from the Graph create-event and list-event examples. The extended property
// itself is omitted from a filtered collection result.
const graphEvent = {
  '@odata.etag': 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJB"',
  id: 'AAMkAGViNDU7zAAAAAGtlAAAMh8kAAA=',
  transactionId,
  type: 'singleInstance',
  isCancelled: false,
  changeKey: 'DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJB',
}
const createdEvent = {
  '@odata.context': `${collection}/$entity`,
  ...graphEvent,
}
const reference = { id: graphEvent.id, etag: graphEvent['@odata.etag'] }
const resource = `${collection}/${encodeURIComponent(graphEvent.id)}`
const updatedEvent = {
  ...graphEvent,
  '@odata.etag': 'W/"DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJC"',
  changeKey: 'DwAAABYAAAC3I5RWx7luSYmfvk6V4H3sAADTeGJC',
  start: { dateTime: '2030-03-10T06:45:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2030-03-10T07:15:00.0000000', timeZone: 'UTC' },
  attendees: [],
}
const signal = () => AbortSignal.timeout(1000)

function providerError(code: string, status: number, retryAfter?: string) {
  return Response.json(
    {
      error: {
        code,
        message: 'private upstream details',
        innerError: { date: '2030-03-10T08:00:00', 'request-id': 'example-request-id' },
      },
    },
    { status, ...(retryAfter && { headers: { 'Retry-After': retryAfter } }) },
  )
}

describe('Microsoft Graph booking event transport', () => {
  it('creates a private appointment with the booking key and DST-correct UTC instants', async () => {
    const deadline = signal()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(url).toBe(collection)
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer fake-access' },
        signal: deadline,
        redirect: 'error',
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        subject: 'Private consultation',
        start: { dateTime: '2030-03-10T06:45:00.000', timeZone: 'UTC' },
        end: { dateTime: '2030-03-10T07:15:00.000', timeZone: 'UTC' },
        isAllDay: false,
        showAs: 'busy',
        sensitivity: 'private',
        isOnlineMeeting: false,
        transactionId,
        singleValueExtendedProperties: [
          {
            id: 'String {3eb52777-459b-4501-8511-4284ebcd11de} Name HourmereBookingKey',
            value: transactionId,
          },
        ],
      })
      return Response.json(createdEvent, { status: 201 })
    })
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(client.createEvent('fake-access', calendarId, booking, deadline)).resolves.toEqual(
      reference,
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains a timed booking at UTC midnight and projects only a group seat count in the body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(createdEvent, { status: 201 }),
    )
    const client = createMicrosoftCalendarClient(config, fetch)
    await client.createEvent(
      'fake-access',
      calendarId,
      {
        ...booking,
        start: new Date('2030-03-11T00:00:00Z'),
        end: new Date('2030-03-11T00:30:00Z'),
        seatCount: 2,
      },
      signal(),
    )
    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(payload).toMatchObject({
      isAllDay: false,
      body: { contentType: 'text', content: '2' },
    })
    expect(payload).not.toHaveProperty('attendees')
    expect(payload).not.toHaveProperty('location')
  })

  it('looks up the key in the selected calendar and follows its opaque next link', async () => {
    const next = `${collection}?$skiptoken=opaque-token`
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ value: [], '@odata.nextLink': next }))
      .mockResolvedValueOnce(Response.json({ value: [graphEvent] }))
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.findEvent('fake-access', calendarId, transactionId, signal()),
    ).resolves.toEqual(reference)
    const lookup = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(lookup.origin + lookup.pathname).toBe(collection)
    expect(lookup.searchParams.get('$filter')).toBe(
      `singleValueExtendedProperties/Any(ep: ep/id eq 'String {3eb52777-459b-4501-8511-4284ebcd11de} Name HourmereBookingKey' and ep/value eq '${transactionId}')`,
    )
    expect(lookup.searchParams.get('$select')).toBe('id,transactionId,type,isCancelled')
    expect(fetch.mock.calls[1]?.[0]).toBe(next)
  })

  it.each([
    { value: [{ ...graphEvent, transactionId: 'different-key' }] },
    { value: [{ ...graphEvent, type: 'seriesMaster' }] },
    { value: [{ ...graphEvent, isCancelled: true }] },
    { value: [graphEvent, { ...graphEvent, id: 'another-event' }] },
    { value: [], '@odata.nextLink': 'https://example.com/calendar' },
    { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/other/events' },
  ])('fails closed on an unverified lookup result', async (fixture) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(fixture))
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.findEvent('fake-access', calendarId, transactionId, signal()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a create response for a different transaction', async () => {
    const client = createMicrosoftCalendarClient(config, async () =>
      Response.json({ ...createdEvent, transactionId: 'unrelated' }, { status: 201 }),
    )
    await expect(
      client.createEvent('fake-access', calendarId, booking, signal()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it.each([
    [401, 'InvalidAuthenticationToken', 'needs_reauth'],
    [403, 'ErrorAccessDenied', 'permissions_missing'],
    [404, 'ErrorItemNotFound', 'provider_unavailable'],
    [409, 'ErrorConflict', 'provider_unavailable'],
    [412, 'ErrorIrresolvableConflict', 'provider_unavailable'],
    [500, 'InternalServerError', 'provider_unavailable'],
    [503, 'ServiceUnavailable', 'provider_unavailable'],
  ])(
    'passes safe Graph HTTP %s details to the retry policy',
    async (status, code, classification) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => providerError(code, status))
      const client = createMicrosoftCalendarClient(config, fetch)
      await expect(
        client.createEvent('fake-access', calendarId, booking, signal()),
      ).rejects.toMatchObject({ status, code: classification, message: classification })
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it.each(['10', 'Sun, 10 Mar 2030 08:00:10 GMT'])(
    'passes Graph throttling delay %s through without resending POST',
    async (retryAfter) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        providerError('TooManyRequests', 429, retryAfter),
      )
      const client = createMicrosoftCalendarClient(config, fetch, () =>
        Date.parse('2030-03-10T08:00:00Z'),
      )
      await expect(
        client.createEvent('fake-access', calendarId, booking, signal()),
      ).rejects.toMatchObject({ status: 429, retryAfterMs: 10_000 })
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it('classifies an invalid_grant refresh response as a reconnect without leaking details', async () => {
    const client = createMicrosoftCalendarClient(config, async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'private upstream details' },
        { status: 400 },
      ),
    )
    await expect(
      client.refresh('fake-refresh', signal(), ['Calendars.ReadWrite']),
    ).rejects.toMatchObject({
      code: 'needs_reauth',
      oauthError: 'invalid_grant',
      message: 'needs_reauth (invalid_grant)',
    })
  })

  it('reports a timeout after sending POST without resending it', async () => {
    const controller = new AbortController()
    const sent = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      sent.resolve()
      return pending.promise
    })
    const client = createMicrosoftCalendarClient(config, fetch)
    const creation = client.createEvent('fake-access', calendarId, booking, controller.signal)
    await sent.promise
    controller.abort(new DOMException('request deadline', 'TimeoutError'))
    await expect(creation).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('conditionally moves the stored event using UTC instants across the DST transition', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(url).toBe(resource)
      expect(init).toMatchObject({
        method: 'PATCH',
        headers: {
          authorization: 'Bearer fake-access',
          'content-type': 'application/json',
          'if-match': reference.etag,
        },
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        start: { dateTime: '2030-03-10T06:45:00.000', timeZone: 'UTC' },
        end: { dateTime: '2030-03-10T07:15:00.000', timeZone: 'UTC' },
      })
      return Response.json(updatedEvent)
    })
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.updateEvent(
        'fake-access',
        calendarId,
        reference.id,
        reference.etag,
        booking,
        signal(),
      ),
    ).resolves.toEqual({ id: reference.id, etag: updatedEvent['@odata.etag'] })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reads a copy for reconciliation and projects the optional plain-text group count', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(new URL(resource).pathname)
      expect(new URL(String(url)).searchParams.get('$select')).toBe(
        'id,transactionId,type,isCancelled,start,end,attendees,body',
      )
      expect(init?.headers).toMatchObject({
        prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
      })
      return Response.json({ ...updatedEvent, body: { contentType: 'text', content: '3' } })
    })
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.getEvent('fake-access', calendarId, reference.id, transactionId, signal(), true),
    ).resolves.toEqual({
      id: reference.id,
      etag: updatedEvent['@odata.etag'],
      start: booking.start,
      end: booking.end,
      hasAttendees: false,
      seatCount: 3,
    })
  })

  it('treats a different transaction at the stored ID as a conflict', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      expect(new URL(String(url)).searchParams.get('$select')).toBe(
        'id,transactionId,type,isCancelled,start,end,attendees',
      )
      return Response.json({ ...updatedEvent, transactionId: null })
    })
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.getEvent('fake-access', calendarId, reference.id, transactionId, signal()),
    ).rejects.toMatchObject({ status: 412 })
  })

  it('recognizes an Outlook edit adding an attendee without returning attendee details', async () => {
    const client = createMicrosoftCalendarClient(config, async () =>
      Response.json({
        ...updatedEvent,
        attendees: [
          {
            type: 'required',
            status: { response: 'none', time: '0001-01-01T00:00:00Z' },
            emailAddress: { name: 'Outlook guest', address: 'attendee@example.invalid' },
          },
        ],
      }),
    )
    await expect(
      client.getEvent('fake-access', calendarId, reference.id, transactionId, signal()),
    ).resolves.toEqual({
      id: reference.id,
      etag: updatedEvent['@odata.etag'],
      start: booking.start,
      end: booking.end,
      hasAttendees: true,
    })
  })

  it('conditionally deletes the matching copy and distinguishes an already absent event', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(providerError('ErrorItemNotFound', 404))
    const client = createMicrosoftCalendarClient(config, fetch)
    const remove = () =>
      client.deleteEvent('fake-access', calendarId, reference.id, reference.etag, signal())
    await expect(remove()).resolves.toBe('deleted')
    await expect(remove()).resolves.toBe('not_found')
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(resource)
      expect(init).toMatchObject({
        method: 'DELETE',
        headers: { authorization: 'Bearer fake-access', 'if-match': reference.etag },
      })
      expect(init?.body).toBeUndefined()
    }
  })

  it('passes on Graph edit conflicts and throttling without replaying mutations', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(providerError('ErrorIrresolvableConflict', 412))
      .mockResolvedValueOnce(providerError('TooManyRequests', 429, '83'))
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.updateEvent(
        'fake-access',
        calendarId,
        reference.id,
        reference.etag,
        booking,
        signal(),
      ),
    ).rejects.toMatchObject({ status: 412, message: 'provider_unavailable' })
    await expect(
      client.deleteEvent('fake-access', calendarId, reference.id, reference.etag, signal()),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 83_000 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects wildcard preconditions and paths outside the scoped calendar', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createMicrosoftCalendarClient(config, fetch)
    await expect(
      client.deleteEvent('fake-access', calendarId, reference.id, '*', signal()),
    ).rejects.toMatchObject({ status: 412 })
    await expect(
      client.deleteEvent('fake-access', calendarId, '..', reference.etag, signal()),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
