import { createHmac, randomUUID } from 'node:crypto'
import type { IDataObject, IHookFunctions, IWebhookFunctions } from 'n8n-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HourmereTrigger } from './HourmereTrigger.node'
import {
  claimEvent,
  createReceiptCoordinator,
  MAX_PROCESS_RECEIPTS,
  MAX_RECEIPT_SCOPES,
  MAX_RECEIPTS,
  RECEIPT_RETENTION_MS,
  verifiedEvent,
} from './signature'

const secret = 'synthetic-unit-test-signing-key'
const id = '11111111-1111-4111-8111-111111111111'
const webhookId = '22222222-2222-4222-8222-222222222222'
const timestamp = () => String(Math.floor(Date.now() / 1000))
const payload = (type = 'booking.created', eventId = id) => ({
  id: eventId,
  type,
  occurredAt: new Date().toISOString(),
  data: {
    bookingId: webhookId,
    organizationId: id,
    eventTypeId: null,
    start: '2027-03-14T09:30:00Z',
    end: '2027-03-14T10:30:00Z',
    status: 'confirmed',
    source: 'api',
    rescheduledFromId: type === 'booking.rescheduled' ? id : null,
  },
})
function sign(raw: Buffer, time = timestamp(), key = secret) {
  return `v1=${createHmac('sha256', key).update(time).update('.').update(raw).digest('hex')}`
}
function hook(data: IDataObject = {}) {
  const request = vi.fn()
  const http = vi.fn(async (...args: unknown[]) => ({
    statusCode: 200,
    headers: {},
    body: await request(...args),
  }))
  return {
    data,
    request,
    context: {
      getWorkflowStaticData: () => data,
      getNodeParameter: () => ['booking.created'],
      getNodeWebhookUrl: () => 'https://automation.example.com/webhook/unique',
      getNode: () => ({ name: 'Hourmere Trigger' }),
      getCredentials: async () => ({
        baseUrl: 'https://hourmere.example.com',
        apiKey: 'synthetic-unit-test-key',
      }),
      helpers: { httpRequestWithAuthentication: http },
    } as unknown as IHookFunctions,
  }
}
function delivery(
  data: IDataObject = { webhookId: randomUUID(), webhookSecret: secret },
  raw = Buffer.from(JSON.stringify(payload())),
) {
  const time = timestamp()
  const response = { status: vi.fn(), send: vi.fn() }
  response.status.mockReturnValue(response)
  response.send.mockReturnValue(response)
  const request = {
    rawBody: raw,
    readRawBody: vi.fn(async () => {}),
    headers: {
      'webhook-timestamp': time,
      'webhook-signature': sign(raw, time),
      'webhook-id': webhookId,
    },
  }
  return {
    data,
    request,
    response,
    context: {
      getWorkflowStaticData: () => data,
      getNodeParameter: () => ['booking.created', 'booking.cancelled', 'booking.rescheduled'],
      getRequestObject: () => request,
      getResponseObject: () => response,
      helpers: { returnJsonArray: (json: IDataObject) => [{ json }] },
    } as unknown as IWebhookFunctions,
  }
}
const node = new HourmereTrigger()
afterEach(() => vi.restoreAllMocks())

describe('Hourmere trigger signature', () => {
  it('accepts exact UTF-8 bytes including spacing, before JSON parsing', () => {
    const raw = Buffer.from(JSON.stringify({ ...payload(), annotation: '预约' }, null, 2))
    const time = timestamp()
    expect(verifiedEvent(raw, time, sign(raw, time), secret)?.id).toBe(id)
  })
  it.each([
    'tampered',
    'wrong secret',
    'unsigned',
    'malformed signature',
    'stale',
    'future',
    'bad timestamp',
  ])('rejects %s delivery', (kind) => {
    const raw = Buffer.from(JSON.stringify(payload()))
    const time =
      kind === 'stale'
        ? String(Math.floor(Date.now() / 1000) - 301)
        : kind === 'future'
          ? String(Math.floor(Date.now() / 1000) + 301)
          : kind === 'bad timestamp'
            ? `${timestamp()}junk`
            : timestamp()
    let signature: unknown = sign(raw, time)
    if (kind === 'unsigned') signature = undefined
    if (kind === 'malformed signature') signature = 'v1=ff'
    expect(
      verifiedEvent(
        kind === 'tampered' ? Buffer.from(JSON.stringify(payload('booking.cancelled'))) : raw,
        time,
        signature,
        kind === 'wrong secret' ? 'another-test-key' : secret,
      ),
    ).toBeUndefined()
  })
  it.each([
    'null',
    '[]',
    '{',
    '{"id":"__proto__"}',
    JSON.stringify({ ...payload(), type: 'unknown.event' }),
  ])('rejects authenticated malformed payload %s', (body) => {
    const raw = Buffer.from(body)
    const time = timestamp()
    expect(verifiedEvent(raw, time, sign(raw, time), secret)).toBeUndefined()
  })
})

describe('Hourmere trigger lifecycle', () => {
  it('registers callback and selected events and retains the secret privately', async () => {
    const h = hook()
    h.request.mockResolvedValue({ webhook: { id: webhookId }, secret })
    expect(await node.webhookMethods.default.create.call(h.context)).toBe(true)
    expect(h.request).toHaveBeenCalledWith(
      'hourmereApi',
      expect.objectContaining({
        method: 'POST',
        url: 'https://hourmere.example.com/api/v1/webhooks',
        body: {
          url: 'https://automation.example.com/webhook/unique',
          events: ['booking.created'],
          isActive: true,
        },
      }),
    )
    expect(h.data.webhookId).toBe(webhookId)
    expect(Boolean(h.data.webhookSecret)).toBe(true)
  })
  it('checks remote identity, active state, URL and subscription', async () => {
    const h = hook({ webhookId, webhookSecret: secret })
    const remote = {
      id: webhookId,
      url: 'https://automation.example.com/webhook/unique',
      isActive: true,
      events: ['booking.created'],
    }
    h.request.mockResolvedValue([remote])
    expect(await node.webhookMethods.default.checkExists.call(h.context)).toBe(true)
    for (const change of [
      { isActive: false },
      { url: 'https://other.example.com' },
      { events: ['booking.cancelled'] },
    ]) {
      h.request.mockResolvedValue([{ ...remote, ...change }])
      expect(await node.webhookMethods.default.checkExists.call(h.context)).toBe(false)
    }
    h.request.mockResolvedValue([])
    expect(await node.webhookMethods.default.checkExists.call(h.context)).toBe(false)
    expect(h.data).toEqual({})
  })
  it('deletes on deactivation and clears private static data only after success', async () => {
    const h = hook({ webhookId, webhookSecret: secret, receipts: { [id]: Date.now() } })
    h.request.mockResolvedValue(undefined)
    expect(await node.webhookMethods.default.delete.call(h.context)).toBe(true)
    expect(h.request).toHaveBeenCalledWith(
      'hourmereApi',
      expect.objectContaining({
        method: 'DELETE',
        url: `https://hourmere.example.com/api/v1/webhooks/${webhookId}`,
      }),
    )
    expect(h.data).toEqual({})
  })
  it('preserves registration when deletion fails', async () => {
    const h = hook({ webhookId, webhookSecret: secret })
    h.request.mockRejectedValue({ statusCode: 403, message: 'forbidden' })
    await expect(node.webhookMethods.default.delete.call(h.context)).rejects.toThrow()
    expect(h.data.webhookId).toBe(webhookId)
  })
  it('replaces mismatched registration without leaving the old endpoint', async () => {
    const h = hook({ webhookId, webhookSecret: secret })
    h.request.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ webhook: { id }, secret })
    await node.webhookMethods.default.create.call(h.context)
    expect(h.request.mock.calls.map((call) => call[1].method)).toEqual(['DELETE', 'POST'])
    expect(h.data.webhookId).toBe(id)
  })
  it('does not swallow registration failures or invalid responses', async () => {
    const h = hook()
    h.request.mockResolvedValue({})
    await expect(node.webhookMethods.default.create.call(h.context)).rejects.toThrow(
      'invalid webhook registration',
    )
    expect(h.data.webhookSecret).toBeUndefined()
  })
})

describe('Hourmere trigger delivery and replay', () => {
  it.each(['booking.created', 'booking.cancelled', 'booking.rescheduled'])(
    'emits %s without rewriting the snapshot, including DST-spanning instants',
    async (type) => {
      const original = payload(type)
      const d = delivery(undefined, Buffer.from(JSON.stringify(original)))
      const result = await node.webhook.call(d.context)
      expect(result.workflowData).toEqual([[{ json: original }]])
      expect(d.request.readRawBody).toHaveBeenCalledOnce()
      expect(d.response.status).not.toHaveBeenCalled()
    },
  )
  it('rejects unsigned requests with HTTP 401 without claiming or emitting', async () => {
    const d = delivery()
    d.request.headers['webhook-signature'] = ''
    expect(await node.webhook.call(d.context)).toEqual({ noWebhookResponse: true })
    expect(d.response.status).toHaveBeenCalledWith(401)
    expect(d.data.receipts).toBeUndefined()
  })
  it('fails closed when n8n provides no raw bytes', async () => {
    const d = delivery()
    Object.assign(d.request, { rawBody: undefined })
    expect(await node.webhook.call(d.context)).toEqual({ noWebhookResponse: true })
    expect(d.response.status).toHaveBeenCalledWith(401)
  })
  it('suppresses concurrent redelivery with fresh signatures and altered unsigned IDs', async () => {
    const d = delivery()
    const results = await Promise.all([node.webhook.call(d.context), node.webhook.call(d.context)])
    expect(results.filter((result) => result.workflowData).length).toBe(1)
    d.request.headers['webhook-id'] = id
    expect(await node.webhook.call(d.context)).toEqual({})
    const restored = delivery(JSON.parse(JSON.stringify(d.data)))
    expect(await node.webhook.call(restored.context)).toEqual({})
  })
  it('does not allow invalid signatures to poison replay receipts', async () => {
    const d = delivery()
    const valid = d.request.headers['webhook-signature']
    d.request.headers['webhook-signature'] = 'v1=ff'
    await node.webhook.call(d.context)
    d.request.headers['webhook-signature'] = valid
    expect((await node.webhook.call(d.context)).workflowData).toBeDefined()
  })
  it('prunes expired receipts but never evicts unexpired receipts at capacity', async () => {
    const receipts = Object.fromEntries(
      Array.from({ length: MAX_RECEIPTS }, (_, index) => [String(index), Date.now()]),
    )
    const d = delivery({ webhookId: randomUUID(), webhookSecret: secret, receipts })
    expect(await node.webhook.call(d.context)).toEqual({ noWebhookResponse: true })
    expect(d.response.status).toHaveBeenCalledWith(503)
    expect(Object.keys(receipts)).toHaveLength(MAX_RECEIPTS)
    receipts['0'] = Date.now() - RECEIPT_RETENTION_MS
    const pruned = delivery({ webhookId: randomUUID(), webhookSecret: secret, receipts })
    expect((await node.webhook.call(pruned.context)).workflowData).toBeDefined()
    expect(Object.keys(pruned.data.receipts as IDataObject)).toHaveLength(MAX_RECEIPTS)
  })
  it('distinguishes a new cancellation/reschedule event from an earlier creation', () => {
    const data: IDataObject = { webhookId: randomUUID(), webhookSecret: secret }
    expect(claimEvent(data, id)).toBe('new')
    expect(claimEvent(data, webhookId)).toBe('new')
    expect(claimEvent(data, id)).toBe('duplicate')
  })
})

describe('Process receipt coordination for n8n request snapshots', () => {
  it('suppresses concurrent requests with separate pre-delivery snapshots and repairs a later lost snapshot', async () => {
    const initial = { webhookId: randomUUID(), webhookSecret: secret }
    const first = delivery(structuredClone(initial))
    const second = delivery(structuredClone(initial))
    const results = await Promise.all([
      node.webhook.call(first.context),
      node.webhook.call(second.context),
    ])
    expect(results.filter((result) => result.workflowData)).toHaveLength(1)
    const lost = delivery(structuredClone(initial))
    expect(await node.webhook.call(lost.context)).toEqual({})
    expect(Object.keys(lost.data.receipts as IDataObject)).toEqual([id])
  })

  it('merges snapshots from different successful events without losing either receipt', () => {
    const claim = createReceiptCoordinator()
    const initial = { webhookId, webhookSecret: secret }
    const first: IDataObject = { ...initial }
    const second: IDataObject = { ...initial }
    expect(claim(first, id)).toBe('new')
    expect(claim(second, webhookId)).toBe('new')
    expect(Object.keys(second.receipts as IDataObject).sort()).toEqual([id, webhookId].sort())
    expect(claim(first, webhookId)).toBe('duplicate')
    expect(Object.keys(first.receipts as IDataObject)).toHaveLength(2)
  })

  it('isolates registrations and secret rotations, restores persisted receipts and expires process receipts', () => {
    const claim = createReceiptCoordinator()
    const now = Date.now()
    const initial = { webhookId, webhookSecret: secret }
    expect(claim({ ...initial, receipts: { [id]: now } }, id, now)).toBe('duplicate')
    expect(claim({ ...initial, webhookId: id }, id, now)).toBe('new')
    expect(claim({ ...initial, webhookSecret: 'rotated-test-key' }, id, now)).toBe('new')
    expect(claim({ ...initial }, id, now + RECEIPT_RETENTION_MS)).toBe('new')
  })

  it('fails closed at the process receipt limit without evicting existing claims', () => {
    const claim = createReceiptCoordinator()
    const now = Date.now()
    const snapshot = Object.fromEntries(
      Array.from({ length: MAX_RECEIPTS }, (_, i) => [String(i), now]),
    )
    for (let i = 0; i < MAX_PROCESS_RECEIPTS / MAX_RECEIPTS; i++) {
      expect(
        claim({ webhookId: String(i), webhookSecret: secret, receipts: snapshot }, '0', now),
      ).toBe('duplicate')
    }
    expect(claim({ webhookId: 'overflow', webhookSecret: secret }, id, now)).toBe('full')
    expect(claim({ webhookId: '0', webhookSecret: secret }, '0', now)).toBe('duplicate')
  })

  it('bounds active registration scopes without evicting their replay protection', () => {
    const claim = createReceiptCoordinator()
    const now = Date.now()
    for (let i = 0; i < MAX_RECEIPT_SCOPES; i++) {
      expect(claim({ webhookId: String(i), webhookSecret: secret }, id, now)).toBe('new')
    }
    expect(claim({ webhookId: 'overflow', webhookSecret: secret }, id, now)).toBe('full')
    expect(claim({ webhookId: '0', webhookSecret: secret }, id, now)).toBe('duplicate')
    expect(
      claim({ webhookId: 'overflow', webhookSecret: secret }, id, now + RECEIPT_RETENTION_MS),
    ).toBe('new')
  })
})
