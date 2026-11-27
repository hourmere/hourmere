import type { PaymentProviderAvailability } from '@hourmere/core/payment'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const PATH = `/app/event-types/${EVENT_TYPE_ID}`
const PATCH = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
const words = {
  en: {
    group: 'Payments',
    charge: 'Charge for bookings',
    currency: 'Currency',
    price30: 'Price for 30 min',
    price45: 'Price for 45 min',
    missing: 'Enter a price for this duration.',
    save: 'Save changes',
    saved: 'Saved.',
  },
  'zh-CN': {
    group: '收款设置',
    charge: '收取预约费用',
    currency: '币种',
    price30: '30 分钟的价格',
    price45: '45 分钟的价格',
    missing: '请输入此时长的价格。',
    save: '保存更改',
    saved: '已保存。',
  },
} as const

function setup(
  saved: EventType,
  availability: PaymentProviderAvailability | 'unknown' = 'available',
  me = ME,
) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, availability === 'unknown' ? {} : { eventTypePaymentAvailability: availability }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () => json(200, { data: [], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [PATCH]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
  })
}

async function openPaymentSettings(
  user: ReturnType<typeof userEvent.setup>,
  label: string = words.en.group,
) {
  const summary = await screen.findByText(label, { selector: 'summary' })
  const group = summary.parentElement as HTMLDetailsElement
  if (!group.open) await user.click(summary)
  return within(group)
}

describe('event payment settings', () => {
  it.each(['en', 'zh-CN'] as const)(
    'requires a price for every duration and saves exact minor units in %s',
    async (locale) => {
      chooseLanguage(locale)
      const copy = words[locale]
      const saved = eventType({ allowedDurationsMinutes: [30, 45] })
      const fake = setup(saved)
      const user = userEvent.setup()
      renderApp(PATH)
      const settings = await openPaymentSettings(user, copy.group)
      await user.click(settings.getByRole('checkbox', { name: copy.charge }))
      const zeroDecimal = locale === 'zh-CN'
      const currency = zeroDecimal ? 'jpy' : 'usd'
      const select = settings.getByLabelText<HTMLSelectElement>(copy.currency)
      expect([...select.options].map((option) => option.value)).toEqual([
        'usd',
        'eur',
        'gbp',
        'cad',
        'aud',
        'jpy',
      ])
      await user.selectOptions(select, currency)
      await user.type(settings.getByLabelText(copy.price30), zeroDecimal ? '500' : '5.29')
      await user.click(screen.getByRole('button', { name: copy.save }))
      expect(settings.getByText(copy.missing)).toBeDefined()
      expect(fake.to(PATCH)).toHaveLength(0)
      const price45 = settings.getByLabelText(copy.price45)
      if (zeroDecimal) {
        await user.type(price45, '100.5')
        await user.click(screen.getByRole('button', { name: copy.save }))
        expect(settings.getByText('请输入整数金额。')).toBeDefined()
        expect(fake.to(PATCH)).toHaveLength(0)
        await user.clear(price45)
      }
      await user.type(price45, zeroDecimal ? '800' : '8.01')
      await user.click(screen.getByRole('button', { name: copy.save }))
      await screen.findByText(copy.saved)
      expect(fake.to(PATCH)[0]?.body).toMatchObject({
        payment: {
          currency,
          prices: [
            { durationMinutes: 30, amountMinor: zeroDecimal ? 500 : 529 },
            { durationMinutes: 45, amountMinor: zeroDecimal ? 800 : 801 },
          ],
        },
      })
    },
  )

  it.each([
    ['stripe_not_configured', 'Ask your instance operator to configure Stripe for paid bookings.'],
    [
      'stripe_unverified',
      'This instance could not verify its Stripe configuration. Contact your instance operator.',
    ],
    ['disabled', 'Paid bookings are turned off on this instance.'],
    ['live_mode_unavailable', 'Paid bookings are currently available in Stripe test mode only.'],
    ['unknown', 'Paid booking settings are unavailable on this instance.'],
  ] as const)('disables price settings with the %s reason', async (availability, reason) => {
    chooseLanguage('en')
    setup(eventType(), availability)
    const user = userEvent.setup()
    renderApp(PATH)
    const settings = await openPaymentSettings(user)
    expect(
      settings.getByRole<HTMLInputElement>('checkbox', { name: words.en.charge }).disabled,
    ).toBe(true)
    expect(settings.getByText(reason)).toBeDefined()
    expect(settings.queryByLabelText(words.en.currency)).toBeNull()
  })

  it.each([
    ['group', eventType({ bookingMode: 'group', groupCapacity: 4 })],
    ['round robin', eventType({ schedulingType: 'round_robin' })],
    ['collective', eventType({ schedulingType: 'collective' })],
    ['guest access', eventType({ allowGuests: true })],
    ['waitlist', eventType({ waitlist: { enabled: true } })],
    ['recurrence or routing restriction', eventType({ paymentAvailability: 'unsupported_event' })],
    ['phone location', eventType({ location: { kind: 'phone', number: '+12025550130' } })],
  ] as const)(
    'disallows payments for %s events even with Stripe configured',
    async (_mode, saved) => {
      chooseLanguage('en')
      setup(saved)
      renderApp(PATH)
      const settings = await openPaymentSettings(userEvent.setup())
      expect(
        settings.getByRole<HTMLInputElement>('checkbox', { name: words.en.charge }).disabled,
      ).toBe(true)
      expect(
        settings.getByText(/Paid bookings are available for personal, one-on-one events/),
      ).toBeDefined()
    },
  )

  it('disallows payments in a team space', async () => {
    chooseLanguage('en')
    setup(eventType({ ownerUserId: null }), 'available', {
      ...ME,
      organization: { ...ME.organization, personal: false },
    })
    renderApp(PATH)
    const settings = await openPaymentSettings(userEvent.setup())
    expect(
      settings.getByRole<HTMLInputElement>('checkbox', { name: words.en.charge }).disabled,
    ).toBe(true)
  })

  it('keeps stored prices through an unrelated edit and lets the host clear them while Stripe is disabled', async () => {
    chooseLanguage('en')
    const payment = {
      currency: 'usd' as const,
      prices: [{ durationMinutes: 30, amountMinor: 529 }],
    }
    const fake = setup(eventType({ payment }), 'disabled')
    const user = userEvent.setup()
    renderApp(PATH)
    const settings = await openPaymentSettings(user)
    const title = screen.getByLabelText('Title', { exact: true })
    await user.clear(title)
    await user.type(title, 'Renamed')
    const save = screen.getByRole('button', { name: words.en.save })
    await user.click(save)
    await screen.findByText(words.en.saved)
    expect(fake.to(PATCH)[0]?.body).not.toHaveProperty('payment')
    expect(settings.queryByLabelText(words.en.currency)).toBeNull()
    await user.click(settings.getByRole('checkbox', { name: words.en.charge }))
    await user.click(save)
    await screen.findByText(words.en.saved)
    expect(fake.to(PATCH)[1]?.body).toMatchObject({ payment: null })
  })
})
