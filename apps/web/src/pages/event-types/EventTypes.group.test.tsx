import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import {
  draftFromEventType,
  emptyDraft,
  serverErrors,
  toInput,
  toPatchInput,
  validateDraft,
} from './event-type-form.ts'

describe('group event editor', () => {
  it.each(['en', 'zh-CN'] as const)('creates a group event in %s', async (language) => {
    chooseLanguage(language)
    let body: Record<string, unknown> | undefined
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(200, eventType({ bookingMode: 'group', groupCapacity: 8 })),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
      'POST /api/v1/event-types': (call) => {
        body = call.body as Record<string, unknown>
        return json(201, eventType({ bookingMode: 'group', groupCapacity: 8 }))
      },
    })
    renderApp('/app/event-types/new')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(language === 'en' ? 'Title' : '标题'), 'Workshop')
    await user.click(screen.getByText(language === 'en' ? 'Group events' : '群组活动'))
    await user.selectOptions(
      screen.getByLabelText(language === 'en' ? 'Booking mode' : '预约模式'),
      'group',
    )
    const capacity = screen.getByLabelText(language === 'en' ? 'Seats per session' : '每场席位数')
    await user.clear(capacity)
    await user.type(capacity, '8')
    await user.click(
      screen.getByRole('button', {
        name: language === 'en' ? 'Create event type' : '创建活动类型',
      }),
    )
    await waitFor(() => expect(body).toMatchObject({ bookingMode: 'group', groupCapacity: 8 }))
  })
  it('round trips stored settings and omits untouched settings from metadata updates', () => {
    const draft = draftFromEventType(eventType({ bookingMode: 'group', groupCapacity: 17 }))
    expect(toInput(draft)).toMatchObject({ bookingMode: 'group', groupCapacity: 17 })
    expect(toPatchInput({ ...draft, title: 'Changed' }, draft)).not.toHaveProperty('bookingMode')
    expect(toPatchInput({ ...draft, title: 'Changed' }, draft)).not.toHaveProperty('groupCapacity')
    expect(toPatchInput({ ...draft, bookingMode: 'individual' }, draft)).toMatchObject({
      bookingMode: 'individual',
      groupCapacity: null,
    })
  })
  it('validates constraints without silently discarding incompatible settings', () => {
    const draft = {
      ...emptyDraft(),
      title: 'Workshop',
      slug: 'workshop',
      bookingMode: 'group' as const,
    }
    expect(validateDraft(draft)).toEqual({})
    expect(validateDraft({ ...draft, groupCapacity: '101' })).toHaveProperty('groupCapacity')
    expect(validateDraft({ ...draft, allowGuests: true })).toHaveProperty('bookingMode')
    expect(validateDraft({ ...draft, waitlistEnabled: true })).not.toHaveProperty('bookingMode')
    expect(validateDraft({ ...draft, schedulingType: 'collective' })).toHaveProperty('bookingMode')
    expect(validateDraft({ ...draft, schedulingType: 'round_robin' })).toHaveProperty('bookingMode')
    expect(
      validateDraft({ ...draft, locationKind: 'phone', phoneAskInvitee: true }),
    ).toHaveProperty('bookingMode')
    expect(
      validateDraft({
        ...draft,
        locationOptions: [
          { id: 'room', kind: 'in_person', address: 'Room', isDefault: true },
          { id: 'phone', kind: 'phone', askInvitee: true },
        ],
      }),
    ).not.toHaveProperty('bookingMode')
    expect(
      serverErrors(new RequestError(409, 'group_mode_has_bookings', ''), draft).fields,
    ).toHaveProperty('bookingMode')
  })
})
