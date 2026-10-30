import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import type { Me } from '../../session.tsx'
import {
  emptyTeamLists,
  fakeApi,
  json,
  ME,
  profile,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const original: Me = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Original team',
    slug: 'original-team',
    personal: false,
  },
}
const target: Me = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000004',
    name: 'Other team',
    slug: 'other-team',
    personal: false,
  },
}

const translations = [
  {
    locale: 'en',
    title: 'Title',
    settings: 'Settings',
    organization: 'Organization',
    save: 'Save changes',
    saved: 'Saved.',
    missing: 'Event type not found',
    prompt: LEAVE_WITH_UNSAVED_CHANGES,
  },
  {
    locale: 'zh-CN',
    title: '标题',
    settings: '设置',
    organization: '组织',
    save: '保存更改',
    saved: '已保存。',
    missing: '找不到活动类型',
    prompt: '你有未保存的更改。离开此页面并放弃更改？',
  },
] as const

type Read = 'focus' | 'visibility'

function dispatchRead(read: Read) {
  if (read === 'focus') fireEvent.focus(window)
  else fireEvent(document, new Event('visibilitychange'))
}

function unloadIsGuarded() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe.each(translations)(
  'declined team switch after an event draft is clean ($locale)',
  (copy) => {
    it.each(
      (['reverted', 'discarded by navigation', 'saved'] as const).flatMap((recovery) =>
        (['focus', 'visibility'] as const).map((read) => ({ recovery, read })),
      ),
    )('follows silently on $read after the draft is $recovery', async ({ recovery, read }) => {
      chooseLanguage(copy.locale)
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      let active = original
      let item = eventType({ organizationId: original.organization.id, ownerUserId: null })
      const calls = fakeApi({
        ...emptyTeamLists,
        ...signedInAs(original),
        ...profile(),
        'GET /api/v1/me': () => json(200, active),
        'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
        'GET /api/v1/event-type-hosts': () =>
          json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: null }),
        [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
          active.organization.id === original.organization.id
            ? json(200, item)
            : json(404, { error: 'event_type_not_found' }),
        [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: (call) => {
          // The fake enforces the same context contract as the real save endpoint.
          if (call.headers.get('X-Expected-Organization-Id') !== active.organization.id)
            return json(409, { error: 'organization_context_changed' })
          item = { ...item, ...(call.body as { title: string }) }
          return json(200, item)
        },
        'GET /api/auth/organization/get-active-member': () =>
          json(200, {
            organizationId: active.organization.id,
            userId: ME.user.id,
            role: 'owner',
          }),
      })
      const title = () => screen.getByLabelText<HTMLInputElement>(copy.title)
      const organization = () => screen.getByText(copy.organization).nextElementSibling?.textContent
      const refresh = async (event: Read) => {
        const previous = calls.to('GET /api/v1/me').length
        await act(async () => dispatchRead(event))
        await waitFor(() => expect(calls.to('GET /api/v1/me')).toHaveLength(previous + 1))
      }

      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByLabelText(copy.title)
      await user.type(title(), ' revised')
      expect(unloadIsGuarded()).toBe(true)

      active = target
      await refresh('focus')
      expect(confirm).toHaveBeenCalledExactlyOnceWith(copy.prompt)
      expect(title().value).toBe('Intro call revised')

      // Focus returned by dismissing confirm and later visible-tab reads must stay quiet.
      for (const repeat of ['focus', 'visibility', 'focus', 'visibility'] as const) {
        await refresh(repeat)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(title().value).toBe('Intro call revised')
        expect(calls.to(`GET /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
      }

      if (recovery === 'reverted') {
        await user.clear(title())
        await user.type(title(), 'Intro call')
      } else if (recovery === 'discarded by navigation') {
        confirm.mockReturnValueOnce(true)
        await user.click(screen.getByRole('link', { name: copy.settings }))
        await screen.findByRole('heading', { name: copy.settings, level: 1 })
        expect(confirm).toHaveBeenCalledTimes(2)
        expect(organization()).toBe(original.organization.name)
      } else {
        // The other tab restores the original context before a valid save, then switches
        // back to the declined target. No intervening /me read clears the declined pair.
        const reads = calls.to('GET /api/v1/me').length
        active = original
        await user.click(screen.getByRole('button', { name: copy.save }))
        await screen.findByText(copy.saved)
        expect(calls.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
        expect(
          calls
            .to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]
            ?.headers.get('X-Expected-Organization-Id'),
        ).toBe(original.organization.id)
        expect(calls.to('GET /api/v1/me')).toHaveLength(reads)
        active = target
      }

      expect(unloadIsGuarded()).toBe(false)
      const prompts = confirm.mock.calls.length
      await refresh(read)
      if (recovery !== 'discarded by navigation') {
        // The original event belongs to the former team and is unavailable after adoption.
        await screen.findByRole('heading', { name: copy.missing, level: 1 })
        await user.click(screen.getByRole('link', { name: copy.settings }))
        await screen.findByRole('heading', { name: copy.settings, level: 1 })
      }
      await waitFor(() => expect(organization()).toBe(target.organization.name))
      expect(confirm).toHaveBeenCalledTimes(prompts)
    })
  },
)
