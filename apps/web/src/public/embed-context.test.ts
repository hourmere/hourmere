import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedMessageContext, notifyEmbedBooked } from './embed-context.ts'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('child embed message context', () => {
  it('refuses duplicate parent origins before posting any completion signal', () => {
    const postMessage = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
    const query = new URLSearchParams({
      parentOrigin: 'https://parent.example',
      embedId: 'abcdefghijklmnop1234',
    })
    window.history.replaceState(null, '', `/embed/ada/intro?${query}`)
    notifyEmbedBooked()
    expect(postMessage.mock.calls).toEqual([
      [{ type: 'hourmere:booked', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
    ])
    postMessage.mockClear()
    for (const secondOrigin of ['https://parent.example', 'https://other.example', '']) {
      const duplicate = new URLSearchParams(query)
      duplicate.append('parentOrigin', secondOrigin)
      window.history.replaceState(null, '', `/embed/ada/intro?${duplicate}`)
      expect(embedMessageContext()).toBeUndefined()
      notifyEmbedBooked()
      expect(postMessage).not.toHaveBeenCalled()
    }
  })
})
