import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

describe.each(['en', 'zh-CN'] as const)('primary invitee phone in %s', (language) => {
  it.each([false, true])('submits an ordered option when editing=%s', async (editing) => {
    chooseLanguage(language)
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(200, eventType({ location: null, locations: null })),
      'POST /api/v1/event-types': () => json(201, eventType()),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    })
    const user = userEvent.setup()
    renderApp(editing ? `/app/event-types/${EVENT_TYPE_ID}` : '/app/event-types/new')
    const title = await screen.findByLabelText(language === 'en' ? 'Title' : '标题', {
      exact: true,
    })
    if (!editing) await user.type(title, 'Phone introduction')
    await user.selectOptions(document.getElementById('location-kind') as HTMLSelectElement, 'phone')
    const checkbox = document.querySelector<HTMLInputElement>(
      'section[aria-label] input[type="checkbox"]',
    )
    expect(checkbox).not.toBeNull()
    const group = checkbox?.closest('details') as HTMLDetailsElement
    await user.click(group.querySelector('summary') as HTMLElement)
    await user.click(checkbox as HTMLInputElement)
    await user.click(
      screen.getByRole('button', {
        name: editing
          ? language === 'en'
            ? 'Save changes'
            : '保存更改'
          : language === 'en'
            ? 'Create event type'
            : '创建活动类型',
      }),
    )
    const route = editing
      ? `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
      : 'POST /api/v1/event-types'
    await waitFor(() => expect(api.to(route)).toHaveLength(1))
    expect(api.to(route)[0]?.body).toMatchObject({
      locations: [{ id: expect.any(String), kind: 'phone', askInvitee: true }],
    })
    expect(api.to(route)[0]?.body).not.toHaveProperty('location')
  })
})
