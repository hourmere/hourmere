import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { BOOKING_ID, booking } from '../../test/fixtures.ts'

describe('host booking unnamed co-hosts', () => {
  it.each([
    ['en', 'People', 'Co-hosts', 'Host', 'Berta Berlin, Host, Host'],
    ['zh-CN', '人员', '共同主持人', '主持人', 'Berta Berlin、主持人、主持人'],
  ] as const)(
    'uses the same neutral label as booking mail in %s without exposing an identity',
    async (locale, heading, label, fallback, names) => {
      chooseLanguage(locale)
      fakeApi({
        ...signedInAs(ME),
        ...profile(),
        [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
          json(
            200,
            booking({
              eventTypeId: null,
              coHosts: [{ name: 'Berta Berlin' }, { name: '' }, { name: '  ' }],
            }),
          ),
      })
      renderApp(`/app/bookings/${BOOKING_ID}`)
      const people = await screen.findByRole('region', { name: heading })
      const term = within(people).getByText(label, { selector: 'dt' })
      expect(term.nextElementSibling?.textContent).toBe(names)
      expect(term.nextElementSibling?.textContent?.split(fallback)).toHaveLength(3)
      expect(term.nextElementSibling?.querySelector('a')).toBeNull()
    },
  )
})
