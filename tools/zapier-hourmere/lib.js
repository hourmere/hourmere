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
  const { allowNotFound, ...httpOptions } = options
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
  if (response.status >= 300) {
    const code = typeof data?.error === 'string' ? data.error : `http_${response.status}`
    const guidance =
      response.status === 401
        ? 'Reconnect with a valid API key.'
        : response.status === 403
          ? 'Check the API key scope and your organization permissions.'
          : 'Check the booking inputs and current availability.'
    const message = `Hourmere: ${code}. ${guidance}`
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

function verifyDelivery(z, bundle, eventType) {
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
  const reject = () => {
    throw new z.errors.Error(
      'Webhook signature or timestamp is invalid.',
      'invalid_webhook_signature',
    )
  }
  if (
    typeof raw?.content !== 'string' ||
    typeof secret !== 'string' ||
    !secret ||
    !/^\d+$/.test(timestamp ?? '') ||
    typeof signature !== 'string' ||
    !/^v1=[0-9a-f]{64}$/.test(signature)
  )
    reject()
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) reject()
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw.content}`).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) reject()
  let event
  try {
    event = JSON.parse(raw.content)
  } catch {
    reject()
  }
  if (
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.type !== eventType ||
    !event.data ||
    typeof event.data.bookingId !== 'string'
  )
    reject()
  // Instant triggers do not deduplicate. The signed event ID remains stable for a
  // downstream durable idempotency guard; valid in-window replays are accepted here.
  // A process-local cache would lose replays across Lambda invocations.
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
