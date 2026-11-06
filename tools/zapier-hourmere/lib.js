const { createHmac, timingSafeEqual } = require('node:crypto')

function baseUrl(z, bundle) {
  let url
  try {
    url = new URL(bundle.authData.baseUrl)
  } catch {
    throw new z.errors.Error(
      'Enter the HTTPS origin of your Hourmere instance.',
      'invalid_base_url',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new z.errors.Error(
      'Use an HTTPS origin without credentials, path, query or fragment.',
      'invalid_base_url',
    )
  }
  return url.origin
}

/** @param {any} z @param {any} bundle @param {string} path @param {Record<string, any>} options */
async function request(z, bundle, path, options = {}) {
  const { allowNotFound, allowDeletedWebhook, ...httpOptions } = options
  const response = await z.request({
    url: `${baseUrl(z, bundle)}/api/v1${path}`,
    ...httpOptions,
    headers: {
      Authorization: `Bearer ${bundle.authData.apiKey}`,
      'Content-Type': 'application/json',
      ...httpOptions.headers,
    },
    skipThrowForStatus: true,
    throwForThrottlingEarly: false,
    redirect: 'error',
  })
  if (response.status === 204) return {}
  const data = response.data
  if (allowNotFound && response.status === 404 && data?.error === 'booking_not_found') return null
  if (allowDeletedWebhook && response.status === 404 && data?.error === 'webhook_not_found')
    return {}
  if (response.status >= 300) {
    const code = typeof data?.error === 'string' ? data.error : `http_${response.status}`
    const guidance =
      response.status === 401
        ? 'Reconnect with a valid API key.'
        : response.status === 403
          ? 'Check the API key scope and your organization permissions.'
          : 'Check the booking inputs and current availability.'
    const message = `Hourmere: ${code}. ${guidance}`
    if (response.status === 401) throw new z.errors.ExpiredAuthError(message)
    const retry = response.headers.get('retry-after')
    if (response.status === 429 || (response.status === 503 && retry)) {
      const seconds = /^\d+$/.test(String(retry))
        ? Number(retry)
        : Math.ceil((Date.parse(retry) - Date.now()) / 1000)
      throw new z.errors.ThrottledError(
        message,
        Number.isFinite(seconds) ? Math.max(1, seconds) : 60,
      )
    }
    throw new z.errors.Error(message, code, response.status)
  }
  return data
}

function publicPath(bundle) {
  const { kind, handle, slug } = bundle.inputData
  return `/public${kind === 'team' ? '/teams' : ''}/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`
}

async function verifyDelivery(z, bundle, eventType) {
  const raw = bundle.rawRequest
  const headers = Object.fromEntries(
    Object.entries(raw?.headers ?? {}).map(([key, value]) => [
      key.toLowerCase().replace(/^http-/, ''),
      value,
    ]),
  )
  const timestamp = headers['webhook-timestamp']
  const signature = headers['webhook-signature']
  const secret = bundle.subscribeData?.secret
  // Log only a fixed reason: never log delivery bytes, signatures or cache errors.
  const reject = (code = 'invalid_webhook_signature') => {
    z.console.log(`Hourmere webhook: ${code}`)
    return []
  }
  if (
    typeof raw?.content !== 'string' ||
    typeof secret !== 'string' ||
    !secret ||
    !/^\d+$/.test(timestamp ?? '') ||
    typeof signature !== 'string' ||
    !/^v1=[0-9a-f]{64}$/.test(signature)
  )
    return reject()
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw.content}`).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) return reject()
  // Zapier acknowledges intake before perform; allow one hour of queue delay.
  // Replay protection comes from the durable atomic claim, not this window.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 3600)
    return reject('stale_webhook_timestamp')
  let event
  try {
    event = JSON.parse(raw.content)
  } catch {
    return reject()
  }
  if (
    typeof bundle.subscribeData?.id !== 'string' ||
    !bundle.subscribeData.id ||
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.type !== eventType ||
    !event.data ||
    typeof event.data.bookingId !== 'string'
  )
    return reject()
  try {
    // 24 hours covers all 12 retries (each capped at one hour), plus queue delay.
    // Each endpoint receives the same event ID, so include the subscription ID.
    const claimed = await z.cache.set(
      `hm:${bundle.subscribeData.id}:${event.id}`,
      1,
      86400,
      null,
      true,
    )
    if (claimed === false) return reject('duplicate_webhook_event')
    if (claimed !== true) z.console.log('Hourmere webhook: replay_cache_unavailable')
  } catch {
    // Intake already succeeded: failing closed here would permanently lose the event.
    z.console.log('Hourmere webhook: replay_cache_unavailable')
  }
  return [
    {
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      bookingId: event.data.bookingId,
      organizationId: event.data.organizationId,
      eventTypeId: event.data.eventTypeId,
      start: event.data.start,
      end: event.data.end,
      status: event.data.status,
      source: event.data.source,
      rescheduledFromId: event.data.rescheduledFromId,
    },
  ]
}

module.exports = { baseUrl, request, publicPath, verifyDelivery }
