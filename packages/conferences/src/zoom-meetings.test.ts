import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createZoomMeetingsClient, zoomJoinUrl, zoomMeetingId } from './zoom-meetings.ts'

const ID = '81234567890',
  HOST = 'synthetic-host',
  ACCESS = 'synthetic-access'
const signal = () => AbortSignal.timeout(1000)
const input = () => ({
  topic: 'Settings',
  start: new Date('2030-01-01T10:00:00Z'),
  end: new Date('2030-01-01T10:30:00Z'),
})
function fake() {
  const controls = {
    response: {
      id: Number(ID),
      host_id: HOST,
      type: 2,
      join_url: `https://us02web.zoom.us/j/${ID}?pwd=synthetic.1`,
      start_time: '2030-01-01T10:00:00Z',
      duration: 30,
      settings: { use_pmi: false },
      start_url: 'synthetic-private-host-start',
      password: 'synthetic-raw-passcode',
      encrypted_password: 'synthetic-raw-pin',
      api_url: 'https://untrusted.invalid',
      pmi: 1234567890,
    } as Record<string, unknown>,
    status: 200,
    hook: undefined as ((url: string, init: RequestInit) => Promise<Response>) | undefined,
  }
  const calls: { url: string; init: RequestInit }[] = []
  const request: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (controls.hook) return controls.hook(String(url), init)
    if (controls.status !== 200)
      return new Response('synthetic-private-upstream', { status: controls.status })
    return init.method === 'PATCH' || init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json(controls.response)
  }
  return { controls, calls, client: createZoomMeetingsClient(request) }
}
describe('fixed Zoom meeting lifecycle adapter', () => {
  it('creates exactly once under me with UTC, type2, no PMI or delegated/invitee fields, using account security defaults', async () => {
    const p = fake(),
      meeting = await p.client.create(ACCESS, HOST, input(), signal())
    expect(p.calls).toHaveLength(1)
    const call = p.calls[0]
    expect(call?.url).toBe('https://api.zoom.us/v2/users/me/meetings')
    expect(call?.init.redirect).toBe('error')
    expect(call?.init.method).toBe('POST')
    expect(new Headers(call?.init.headers).get('authorization')).toBe(`Bearer ${ACCESS}`)
    expect(JSON.parse(String(call?.init.body))).toEqual({
      topic: 'Settings',
      start_time: '2030-01-01T10:00:00Z',
      duration: 30,
      timezone: 'UTC',
      type: 2,
      default_password: true,
      settings: { use_pmi: false },
    })
    expect(meeting).toEqual({
      id: ID,
      hostId: HOST,
      joinUrl: `https://us02web.zoom.us/j/${ID}?pwd=synthetic.1`,
      start: '2030-01-01T10:00:00.000Z',
      duration: 30,
    })
    expect(JSON.stringify(meeting)).not.toMatch(
      /start_url|password|api_url|synthetic-private|synthetic-raw/,
    )
  })
  it('GETs the pinned host/ID before same-ID PATCH/DELETE, never creates or changes security on reschedule', async () => {
    const p = fake()
    await p.client.update(ACCESS, HOST, ID, input(), signal())
    await p.client.remove(ACCESS, HOST, ID, signal())
    expect(p.calls.map((c) => c.init.method)).toEqual(['GET', 'PATCH', 'GET', 'GET', 'DELETE'])
    expect(p.calls.every((c) => c.url === `https://api.zoom.us/v2/meetings/${ID}`)).toBe(true)
    const body = JSON.parse(String(p.calls[1]?.init.body))
    expect(body).toEqual({
      topic: 'Settings',
      start_time: '2030-01-01T10:00:00Z',
      duration: 30,
      timezone: 'UTC',
    })
    expect(p.calls.every((c) => c.init.redirect === 'error' && !c.url.includes(ACCESS))).toBe(true)
  })
  it('treats a missing known ID as absent without creating a replacement', async () => {
    const p = fake()
    p.controls.status = 404
    expect(await p.client.get(ACCESS, HOST, ID, signal())).toBeNull()
    expect(await p.client.update(ACCESS, HOST, ID, input(), signal())).toBeNull()
    await expect(p.client.remove(ACCESS, HOST, ID, signal())).resolves.toBeUndefined()
    expect(p.calls.map((c) => c.init.method)).toEqual(['GET', 'GET', 'GET'])
  })
  it.each([
    { host_id: 'another-owner' },
    { id: '92345678901' },
    { type: 3 },
    { settings: { use_pmi: true } },
  ])('refuses a foreign/different/recurring/PMI meeting before mutation', async (change) => {
    const p = fake()
    Object.assign(p.controls.response, change)
    await expect(p.client.update(ACCESS, HOST, ID, input(), signal())).rejects.toThrow(
      'provider_unavailable',
    )
    await expect(p.client.remove(ACCESS, HOST, ID, signal())).rejects.toThrow(
      'provider_unavailable',
    )
    expect(p.calls.map((c) => c.init.method)).toEqual(['GET', 'GET'])
  })
  it('retains validated identity when response details are unsafe, allowing only known-ID reconciliation', async () => {
    const p = fake()
    p.controls.response.join_url = 'https://untrusted.invalid/j/81234567890'
    p.controls.response.start_time = '2030-02-30T10:00:00Z'
    p.controls.response.duration = 1.5
    const result = await p.client.create(ACCESS, HOST, input(), signal())
    expect(result).toEqual({ id: ID, hostId: HOST, joinUrl: null, start: null, duration: null })
    expect(p.calls).toHaveLength(1)
  })
  it.each([
    0,
    -1,
    1.2,
    Number.MAX_SAFE_INTEGER + 1,
    1e20,
    '01234567890',
    '1e10',
    '../81234567890',
    '8123456789012345',
    null,
  ])('refuses unsafe numeric identities: %s', async (id) => {
    const p = fake()
    p.controls.response.id = id
    expect(zoomMeetingId(id)).toBeNull()
    await expect(p.client.create(ACCESS, HOST, input(), signal())).rejects.toThrow(
      'provider_unavailable',
    )
    expect(p.calls).toHaveLength(1)
  })
  it.each([0, 1.5, 1441, -1, Number.NaN])(
    'validates minute duration before create: %s',
    async (duration) => {
      const p = fake(),
        values = input()
      values.end = new Date(values.start.getTime() + duration * 60000)
      await expect(p.client.create(ACCESS, HOST, values, signal())).rejects.toThrow(
        'provider_unavailable',
      )
      expect(p.calls).toHaveLength(0)
    },
  )
  it.each([302, 400, 401, 403, 429, 500])(
    'does not retry unknown create HTTP %s or expose upstream prose',
    async (status) => {
      const p = fake()
      p.controls.status = status
      try {
        await p.client.create(ACCESS, HOST, input(), signal())
        throw new Error('Expected failure')
      } catch (error) {
        expect(String(error)).toMatch(/provider_unavailable|needs_reauth|permissions_missing/)
        expect(String(error)).not.toContain('synthetic-private')
        expect((error as Error).cause).toBeUndefined()
      }
      expect(p.calls).toHaveLength(1)
    },
  )
  it('never follows redirects, bounds bodies and enforces deadlines on ignored signals', async () => {
    const p = fake()
    p.controls.hook = async () => new Response('x'.repeat(131073))
    await expect(p.client.create(ACCESS, HOST, input(), signal())).rejects.toThrow(
      'provider_unavailable',
    )
    p.controls.hook = async () => new Response('{')
    await expect(p.client.get(ACCESS, HOST, ID, signal())).rejects.toThrow('provider_unavailable')
    const response = Promise.withResolvers<Response>(),
      controller = new AbortController()
    p.controls.hook = () => response.promise
    let settled = false
    const result = p.client.create(ACCESS, HOST, input(), controller.signal).then(
      (value) => {
        settled = true
        return { value }
      },
      (error) => {
        settled = true
        return { error }
      },
    )
    try {
      expect(p.calls).toHaveLength(3)
      expect(controller.signal.aborted).toBe(false)
      controller.abort(new DOMException('Synthetic timeout', 'TimeoutError'))
      // Drain abort continuations while the provider response remains unresolved.
      await setImmediate()
      expect(settled).toBe(true)
      expect(await result).toMatchObject({ error: { message: 'provider_unavailable' } })
    } finally {
      response.resolve(Response.json(p.controls.response))
      await result
    }
    expect(p.calls).toHaveLength(3)
    await expect(p.client.create(ACCESS, HOST, input(), AbortSignal.abort())).rejects.toThrow(
      'provider_unavailable',
    )
    expect(p.calls).toHaveLength(3)
  })
})
describe('commercial Zoom participant link allowlist', () => {
  it.each([
    'zoom.us',
    'us02web.zoom.us',
    'us04web.zoom.us',
    'us05web.zoom.us',
    'us06web.zoom.us',
    'us07web.zoom.us',
    'au01web.zoom.us',
    'ca01web.zoom.us',
    'eu01web.zoom.us',
    'eu02web.zoom.us',
    'in01web.zoom.us',
    'sa01web.zoom.us',
    'dg01web.zoom.us',
    'sg01web.zoom.us',
    'uk01web.zoom.us',
  ])('accepts a fixed known commercial host: %s', (host) => {
    expect(zoomJoinUrl(`https://${host}/j/${ID}`, ID)).toBe(`https://${host}/j/${ID}`)
    expect(zoomJoinUrl(`https://${host}/j/${ID}?pwd=synthetic_-.1`, ID)).toBe(
      `https://${host}/j/${ID}?pwd=synthetic_-.1`,
    )
  })
  it.each([
    `http://zoom.us/j/${ID}`,
    `https://user@zoom.us/j/${ID}`,
    `https://zoom.us:443/j/${ID}`,
    `https://zoom.us:444/j/${ID}`,
    `https://zoom.us/j/${ID}#fragment`,
    `https://zoom.us/j/99999999999`,
    `https://zoom.us/j/${ID}/`,
    `https://zoom.us/wc/${ID}/join`,
    `https://zoom.us/j/${ID}?`,
    `https://zoom.us/j/${ID}?pwd=`,
    `https://zoom.us/j/${ID}?pwd=x&pwd=y`,
    `https://zoom.us/j/${ID}?zak=synthetic`,
    `https://zoom.us/j/${ID}?pwd=x&uname=synthetic`,
    `https://zoom.us/j/${ID}?pwd=${'x'.repeat(129)}`,
    `https://zoom.us/j/${ID}?pwd=a%2E1`,
    `https://zoom.us.evil.invalid/j/${ID}`,
    `https://myvanity.zoom.us/j/${ID}`,
    `https://us99web.zoom.us/j/${ID}`,
    `https://zoomgov.com/j/${ID}`,
    `https://zoom.us/j/%38${ID.slice(1)}`,
    `https://ZOOM.US/j/${ID}`,
    `https://zoom.us/j/${ID}\n`,
  ])('refuses capabilities and domains outside the explicit policy', (url) => {
    expect(zoomJoinUrl(url, ID)).toBeNull()
  })
})
