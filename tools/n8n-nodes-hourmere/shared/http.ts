import {
  type IDataObject,
  type IExecuteFunctions,
  type IHookFunctions,
  type IHttpRequestMethods,
  type IWebhookFunctions,
  NodeOperationError,
  sleep,
} from 'n8n-workflow'

type Context = IExecuteFunctions | IHookFunctions | IWebhookFunctions

export function baseUrl(value: unknown): string {
  const url = new URL(String(value))
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter an HTTP(S) base URL without credentials, query, or fragment')
  }
  return url.href.replace(/\/$/, '')
}

export class HourmereApiError extends NodeOperationError {
  httpCode: string
  constructor(node: ReturnType<Context['getNode']>, message: string, status: number) {
    super(node, message)
    this.httpCode = String(status)
  }
}

export async function hourmereRequest(
  this: Context,
  method: IHttpRequestMethods,
  path: string,
  body?: IDataObject,
  qs?: IDataObject,
  headers?: Record<string, string>,
): Promise<IDataObject> {
  const credentials = await this.getCredentials('hourmereApi')
  const url = `${baseUrl(credentials.baseUrl)}/api/v1${path}`
  for (let attempt = 0; ; attempt++) {
    let response: { statusCode: number; headers: Record<string, string>; body: IDataObject }
    try {
      response = await this.helpers.httpRequestWithAuthentication.call(this, 'hourmereApi', {
        method,
        url,
        body,
        qs,
        headers,
        json: true,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        disableFollowRedirect: true,
      })
    } catch {
      // Driver errors may contain authorization headers, URLs, and request bodies.
      throw new NodeOperationError(
        this.getNode(),
        'Hourmere request failed (network_error). Check the base URL and connectivity.',
      )
    }
    if (response.statusCode >= 200 && response.statusCode < 300) return response.body ?? {}
    const code =
      typeof response.body?.error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(response.body.error)
        ? response.body.error
        : 'request_failed'
    const retryHeader = response.headers?.['retry-after'] ?? response.headers?.['Retry-After']
    const retrySeconds =
      retryHeader && /^\d+$/.test(retryHeader)
        ? Number(retryHeader)
        : retryHeader
          ? Math.max(0, Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000))
          : undefined
    if (
      response.statusCode === 429 &&
      attempt === 0 &&
      retrySeconds !== undefined &&
      Number.isFinite(retrySeconds) &&
      retrySeconds <= 60
    ) {
      await sleep(retrySeconds * 1000)
      continue
    }
    const retry =
      response.statusCode === 429
        ? ` Retry after ${Number.isFinite(retrySeconds) ? `${retrySeconds} seconds` : 'the server rate-limit window'}; configure a Wait node before retrying.`
        : ''
    throw new HourmereApiError(
      this.getNode(),
      `Hourmere API ${response.statusCode} (${code}).${retry}`,
      response.statusCode,
    )
  }
}
