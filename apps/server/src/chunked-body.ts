// Test support: a request body sent in chunks without Content-Length, as a client streaming
// its request sends it, that records how much of it the server has read.

/** Bytes per chunk. */
export const CHUNK_SIZE = 16 * 1024

export interface ChunkedBody {
  /** The body's RequestInit fields, to pass along with method and headers. */
  init: { body: ReadableStream<Uint8Array>; duplex: 'half' }
  /** How many bytes the server has read so far. */
  pulled: () => number
}

/** `text` as a body whose chunks are produced only when the server reads them. */
export function chunkedBody(text: string): ChunkedBody {
  const bytes = new TextEncoder().encode(text)
  let pulled = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= bytes.length) {
          controller.close()
          return
        }
        const chunk = bytes.slice(pulled, pulled + CHUNK_SIZE)
        pulled += chunk.length
        controller.enqueue(chunk)
      },
    },
    { highWaterMark: 0 },
  )
  return { init: { body, duplex: 'half' }, pulled: () => pulled }
}
