// A single stateless MCP call. No automatic retries: a lost reschedule response is ambiguous.
export const MAX_INPUT_BYTES = 2 * 1024 * 1024 - 4096
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const PROTOCOL = '2026-07-28'

export class CliError extends Error {
  readonly code: string
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(code: string, status?: number, retryAfterSeconds?: number) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function endpoint(value: string | undefined): URL {
  try {
    const url = new URL(value ?? '')
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error()
    return new URL('/mcp', url)
  } catch {
    throw new CliError('invalid_url')
  }
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : fallback
}

function retrySeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new CliError('invalid_response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new CliError('response_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (mediaType === 'application/json') return JSON.parse(text)
    if (mediaType !== 'text/event-stream') throw new Error()
    // MCP notifications can precede the one JSON-RPC response. An SSE event's data may span lines.
    const messages: unknown[] = []
    for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      const message: unknown = JSON.parse(data)
      if (isObject(message) && message.id === 1) messages.push(message)
    }
    if (messages.length !== 1) throw new Error()
    return messages[0]
  } catch {
    throw new CliError('invalid_response')
  }
}

export async function callTool(options: {
  url: URL
  key: string
  tool: string
  input: Record<string, unknown>
  fetch?: typeof fetch
}): Promise<Record<string, unknown>> {
  const { url, key, tool, input } = options
  if (!/^hm_[A-Za-z0-9_-]{1,512}$/.test(key)) throw new CliError('invalid_api_key')
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: tool,
      arguments: input,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  })
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new CliError('input_too_large')
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      // Never forward a key to a redirect target, even on the same origin.
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': tool,
      },
      body,
    })
    let reply: unknown
    try {
      reply = await readResponse(response)
    } catch (error) {
      if (response.ok) throw error
      // Proxies may answer with HTML. Preserve the HTTP category without echoing their body.
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after')
      throw new CliError(
        safeCode(isObject(reply) ? reply.error : undefined, 'http_error'),
        response.status,
        retry && /^\d{1,9}$/.test(retry) ? retrySeconds(Number(retry)) : undefined,
      )
    }
    if (!isObject(reply) || reply.jsonrpc !== '2.0' || reply.id !== 1 || !isObject(reply.result))
      throw new CliError('invalid_response')
    const result = reply.result
    if (result.isError === true) {
      let detail: unknown
      try {
        const content = result.content
        detail =
          Array.isArray(content) && isObject(content[0]) && typeof content[0].text === 'string'
            ? JSON.parse(content[0].text)
            : undefined
      } catch {
        // Neither server errors nor SDK messages are safe to echo into a terminal.
      }
      throw new CliError(
        safeCode(isObject(detail) ? detail.error : undefined, 'tool_error'),
        undefined,
        retrySeconds(isObject(detail) ? detail.retryAfterSeconds : undefined),
      )
    }
    if (result.isError !== undefined && result.isError !== false)
      throw new CliError('invalid_response')
    if (!isObject(result.structuredContent)) throw new CliError('invalid_response')
    return result.structuredContent
  } catch (error) {
    if (error instanceof CliError) throw error
    // Do not expose fetch exception causes: they may contain URLs, headers or server text.
    throw new CliError('request_failed')
  }
}
