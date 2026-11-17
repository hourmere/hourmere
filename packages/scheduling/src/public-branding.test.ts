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
        logoUrl: null,
      })
    },
  )
})

describe('public brand name', () => {
  function row(extra: Record<string, unknown>): Db {
    const query = {
      innerJoin: () => query,
      leftJoin: () => query,
      select: () => query,
      where: () => query,
      executeTakeFirst: async () => ({
        name: 'jane.doe',
        brand_primary_color: '#000000',
        data: null,
        ...extra,
      }),
    }
    return { selectFrom: () => query } as unknown as Db
  }
  it('uses the team name for a team', async () => {
    const brand = await getPublicBranding(
      row({ name: 'Acme', personal_user_id: null }),
      'organization',
    )
    expect(brand?.name).toBe('Acme')
  })
  // A personal space is created with the mailbox prefix as its name when the person gave none.
  it.each([
    { user_name: 'Jane Doe', handle: 'jane', shown: 'Jane Doe' },
    { user_name: '  ', handle: 'jane', shown: 'jane' },
    { user_name: null, handle: null, shown: '' },
  ])(
    'never publishes a personal space’s internal name: $shown',
    async ({ user_name, handle, shown }) => {
      const brand = await getPublicBranding(
        row({ personal_user_id: 'user', user_name, handle }),
        'organization',
      )
      expect(brand?.name).toBe(shown)
    },
  )
})
