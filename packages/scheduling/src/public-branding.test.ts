import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { getPublicBranding } from './branding.ts'

function stored(color: string | null): Db {
  const query = {
    innerJoin: () => query,
    leftJoin: () => query,
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => ({ name: 'Example', brand_primary_color: color, data: null }),
  }
  return { selectFrom: () => query } as unknown as Db
}

describe('public branding stored-value validation', () => {
  it.each([null, '', 'red', '#123', '#GGGGGG', '#FFFFFF; color:red', 'javascript:alert(1)'])(
    'falls back for invalid stored color %s',
    async (color) => {
      expect(await getPublicBranding(stored(color), 'organization')).toBeUndefined()
    },
  )
  it.each(['#FFFFFF', '#000000', '#aabbcc'])(
    'keeps valid light and dark colors for accessible palette derivation: %s',
    async (color) => {
      expect(await getPublicBranding(stored(color), 'organization')).toEqual({
        name: 'Example',
        primaryColor: color.toUpperCase(),
        logoDataUrl: null,
      })
    },
  )
})
