import { PHONE_NUMBER_PATTERN } from '@hourmere/scheduling'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'

export type SmsErrorCode =
  | 'sms_not_configured'
  | 'sms_invalid_request'
  | 'sms_rate_limited'
  | 'sms_delivery_unknown'
  | 'sms_idempotency_conflict'
  | 'sms_provider_rejected'
  | 'sms_timeout'

/** Safe diagnostics only: never attach request/response bodies, phones or causes. */
export class SmsError extends Error {
  readonly code: SmsErrorCode
  readonly providerCode: number | undefined
  readonly retryAfterSeconds: number | undefined
  constructor(
    code: SmsErrorCode,
    options: { providerCode?: number | undefined; retryAfterSeconds?: number | undefined } = {},
  ) {
    super(code)
    this.name = 'SmsError'
    this.code = code
    this.providerCode = options.providerCode
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}
export interface SmsInput {
  to: string
  body: string
  idempotencyKey: string
}
export interface SmsProvider {
  sendSms(input: SmsInput): Promise<{ providerMessageId: string }>
}
export interface TwilioSmsConfig {
  accountSid: string
  authToken?: string | undefined
  apiKeySid?: string | undefined
  apiKeySecret?: string | undefined
  messagingServiceSid?: string | undefined
  from?: string | undefined
}

/** Existing strict E.164 contract; no implicit country or permissive prose parsing. */
export function normalizeSmsDestination(value: string): string {
  if (typeof value !== 'string' || !PHONE_NUMBER_PATTERN.test(value.trim()))
    throw new SmsError('sms_invalid_request')
  const phone = parsePhoneNumberFromString(value.trim())
  const type = phone?.getType()
  // Positive type allow-list also denies premium, short codes and unknown types.
  if (!phone?.isValid() || (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE'))
    throw new SmsError('sms_invalid_request')
  return phone.number
}
export function maskSmsNumber(value: string): string {
  return `+****${value.slice(-2)}`
}
export function validateSmsInput(input: SmsInput): string {
  const to = normalizeSmsDestination(input.to)
  if (
    typeof input.body !== 'string' ||
    !input.body.trim() ||
    input.body.length > 1600 ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(input.idempotencyKey)
  )
    throw new SmsError('sms_invalid_request')
  return to
}
export const unconfiguredSmsProvider: SmsProvider = {
  async sendSms() {
    throw new SmsError('sms_not_configured')
  },
}

/** A deterministic test double; captures only masked destinations, never message bodies. */
export function createFakeSmsProvider() {
  const calls: { to: string; idempotencyKey: string }[] = []
  return {
    calls,
    async sendSms(input: SmsInput) {
      const to = validateSmsInput(input)
      calls.push({ to: maskSmsNumber(to), idempotencyKey: input.idempotencyKey })
      return { providerMessageId: `fake-${calls.length}` }
    },
  } satisfies SmsProvider & { calls: typeof calls }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SmsError('sms_timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new SmsError('sms_delivery_unknown')
  try {
    const parts: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      length += value.byteLength
      if (length > 32768) throw new SmsError('sms_delivery_unknown')
      parts.push(value)
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new SmsError('sms_delivery_unknown')
    return value as Record<string, unknown>
  } finally {
    void reader.cancel().catch(() => {})
  }
}
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86400) : undefined
}

/** Fixed official endpoint, no operator/user URL overrides. Never automatically retry POST. */
export function createTwilioSmsProvider(
  config: TwilioSmsConfig,
  request: typeof fetch = fetch,
  timeoutMs = 10000,
): SmsProvider {
  const tokenAuth = !!config.authToken && !config.apiKeySid && !config.apiKeySecret
  const keyAuth =
    !config.authToken && /^SK[0-9a-f]{32}$/i.test(config.apiKeySid ?? '') && !!config.apiKeySecret
  if (
    !/^AC[0-9a-f]{32}$/i.test(config.accountSid) ||
    (!tokenAuth && !keyAuth) ||
    !!config.from === !!config.messagingServiceSid ||
    (config.from && !PHONE_NUMBER_PATTERN.test(config.from)) ||
    (config.messagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(config.messagingServiceSid)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new SmsError('sms_invalid_request')
  const authorization = `Basic ${Buffer.from(`${config.apiKeySid ?? config.accountSid}:${config.apiKeySecret ?? config.authToken}`).toString('base64')}`
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`
  return {
    async sendSms(input) {
      const to = validateSmsInput(input)
      const body = new URLSearchParams({ To: to, Body: input.body })
      if (config.messagingServiceSid) body.set('MessagingServiceSid', config.messagingServiceSid)
      else body.set('From', config.from as string)
      // Twilio does not document an idempotency guarantee for Messages POST. The durable
      // service reserves this job key before calling us and never replays an uncertain send.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await abortable(
          request(url, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
            body,
          }),
          controller.signal,
        )
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {})
          throw new SmsError('sms_delivery_unknown')
        }
        // Receiving 429 proves Twilio did not process the request, even when its
        // optional error body is absent, malformed, oversized or interrupted.
        let data: Record<string, unknown>
        try {
          data = await boundedJson(response, controller.signal)
        } catch (error) {
          if (response.status !== 429) throw error
          data = {}
        }
        if (!response.ok) {
          const providerCode =
            Number.isSafeInteger(data.code) && typeof data.code === 'number' && data.code >= 0
              ? data.code
              : undefined
          throw new SmsError(
            response.status === 429
              ? 'sms_rate_limited'
              : response.status >= 400 && response.status < 500
                ? 'sms_provider_rejected'
                : 'sms_delivery_unknown',
            {
              providerCode,
              retryAfterSeconds:
                response.status === 429
                  ? retryAfter(response.headers.get('retry-after'))
                  : undefined,
            },
          )
        }
        if (typeof data.sid !== 'string' || !/^SM[0-9a-f]{32}$/i.test(data.sid))
          throw new SmsError('sms_delivery_unknown')
        return { providerMessageId: data.sid }
      } catch (error) {
        if (error instanceof SmsError) throw error
        throw new SmsError(controller.signal.aborted ? 'sms_timeout' : 'sms_delivery_unknown')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
