// Test support: raw HTTP clients that send slowly, as a slowloris attack does, or keep a
// connection open between requests.
import { connect } from 'node:net'

export interface TrickleOptions {
  /** Written as soon as the connection is up. */
  first: string
  /** Then written every `everyMs` until the server hangs up; nothing if empty. */
  drip?: string
  everyMs?: number
  /** Fails if the server has not hung up by then. */
  giveUpMs?: number
}

export interface KeptAliveOptions {
  /** A whole request whose answer has a Content-Length; the connection stays open after it. */
  first: string
  /** How long to leave the connection idle after the answer before sending `second`. */
  idleMs?: number
  /** Then written on the same connection, followed by `drip` as in trickle; none if unset. */
  second?: string
  drip?: string
  everyMs?: number
  giveUpMs?: number
}

/**
 * Talks raw HTTP to 127.0.0.1:`port` and resolves, once the server closes the connection,
 * with everything it answered and how long after connecting it closed.
 */
export function trickle(
  port: number,
  { first, drip, everyMs, giveUpMs }: TrickleOptions,
): Promise<{ response: string; closedAfterMs: number }> {
  return converse(port, { start: first, drip, everyMs, giveUpMs }).then(
    ({ response, closedAt, connectedAt }) => ({ response, closedAfterMs: closedAt - connectedAt }),
  )
}

/**
 * Sends one whole request, waits for its answer, then leaves the connection idle or, after
 * `idleMs`, starts a second request on it. Resolves once the server closes the connection,
 * with everything it answered and how long after the first answer it closed.
 */
export async function afterOneRequest(
  port: number,
  { first, idleMs = 0, second, drip, everyMs, giveUpMs }: KeptAliveOptions,
): Promise<{ response: string; closedAfterAnswerMs: number }> {
  const { response, closedAt, answeredAt } = await converse(port, {
    start: first,
    waitForAnswer: true,
    followUp: second === undefined ? undefined : { afterMs: idleMs, text: second },
    drip,
    everyMs,
    giveUpMs,
  })
  if (answeredAt === undefined) throw new Error(`no complete first answer: ${response}`)
  return { response, closedAfterAnswerMs: closedAt - answeredAt }
}

/** Where the first answer ends, once it has arrived whole (it must have a Content-Length). */
function firstAnswerEnd(response: string): number | undefined {
  const headerEnd = response.indexOf('\r\n\r\n')
  if (headerEnd < 0) return undefined
  const length = /\r\ncontent-length: *(\d+)/i.exec(response.slice(0, headerEnd))?.[1]
  if (length === undefined) return undefined
  const end = headerEnd + 4 + Number(length)
  return response.length >= end ? end : undefined
}

function converse(
  port: number,
  {
    start,
    waitForAnswer = false,
    followUp,
    drip = '',
    everyMs = 50,
    giveUpMs = 4000,
  }: {
    start: string
    /** Note when the answer to `start` is complete, and only then send `followUp` and drip. */
    waitForAnswer?: boolean
    followUp?: { afterMs: number; text: string } | undefined
    drip?: string | undefined
    everyMs?: number | undefined
    giveUpMs?: number | undefined
  },
): Promise<{ response: string; connectedAt: number; answeredAt?: number; closedAt: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let connectedAt = Date.now()
    let answeredAt: number | undefined
    let response = ''
    let dripping: NodeJS.Timeout | undefined
    let waiting: NodeJS.Timeout | undefined
    const startDripping = () => {
      if (drip) {
        dripping = setInterval(() => {
          if (socket.writable) socket.write(drip)
        }, everyMs)
      }
    }
    const giveUp = setTimeout(() => {
      socket.destroy()
      reject(new Error(`still connected after ${giveUpMs} ms; received: ${response}`))
    }, giveUpMs)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      response += chunk
      if (waitForAnswer && answeredAt === undefined && firstAnswerEnd(response) !== undefined) {
        answeredAt = Date.now()
        if (followUp) {
          waiting = setTimeout(() => {
            socket.write(followUp.text)
            startDripping()
          }, followUp.afterMs)
        }
      }
    })
    // A reset after the server gave up is still the server hanging up.
    socket.on('error', () => {})
    socket.on('close', () => {
      clearInterval(dripping)
      clearTimeout(waiting)
      clearTimeout(giveUp)
      resolve({ response, connectedAt, answeredAt, closedAt: Date.now() })
    })
    socket.on('connect', () => {
      connectedAt = Date.now()
      socket.write(start)
      if (!waitForAnswer) startDripping()
    })
  })
}
