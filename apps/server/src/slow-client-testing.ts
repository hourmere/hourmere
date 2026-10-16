// Test support: a client that sends a request slowly, as a slowloris attack does.
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

/**
 * Talks raw HTTP to 127.0.0.1:`port` and resolves, once the server closes the connection,
 * with everything it answered and how long after connecting it closed.
 */
export function trickle(
  port: number,
  { first, drip = '', everyMs = 50, giveUpMs = 4000 }: TrickleOptions,
): Promise<{ response: string; closedAfterMs: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let started = Date.now()
    let response = ''
    let dripping: NodeJS.Timeout | undefined
    const giveUp = setTimeout(() => {
      socket.destroy()
      reject(new Error(`still connected after ${giveUpMs} ms; received: ${response}`))
    }, giveUpMs)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      response += chunk
    })
    // A reset after the server gave up is still the server hanging up.
    socket.on('error', () => {})
    socket.on('close', () => {
      clearInterval(dripping)
      clearTimeout(giveUp)
      resolve({ response, closedAfterMs: Date.now() - started })
    })
    socket.on('connect', () => {
      started = Date.now()
      socket.write(first)
      if (drip) {
        dripping = setInterval(() => {
          if (socket.writable) socket.write(drip)
        }, everyMs)
      }
    })
  })
}
