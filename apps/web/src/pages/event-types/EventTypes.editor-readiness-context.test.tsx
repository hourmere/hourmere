import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const TEAM = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Design team',
    slug: 'design-team',
    personal: false,
  },
}
const TEAM_ROUTE = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
const SELF_ROUTE = 'GET /api/v1/readiness/self'
const PATCH_ROUTE = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`

function server(overrides: Routes = {}, me = TEAM) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
      json(
        200,
        eventType({
          organizationId: me.organization.id,
          ownerUserId: me.organization.personal ? me.user.id : null,
        }),
      ),
    ...overrides,
  })
}

describe('saved event readiness access and context', () => {
  it.each([
    { status: 403, code: 'team_management_access_denied', me: TEAM, unavailable: true },
    { status: 503, code: 'team_management_access_denied', me: TEAM, unavailable: false },
    { status: 403, code: 'forbidden', me: TEAM, unavailable: false },
    { status: 403, code: 'team_management_access_denied', me: ME, unavailable: false },
  ])(
    'maps $status $code in personal=$me.organization.personal to unavailable=$unavailable',
    async ({ status, code, me, unavailable }) => {
      const route = me.organization.personal ? SELF_ROUTE : TEAM_ROUTE
      const api = server({ [route]: () => json(status, { error: code }) }, me)
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const panel = await screen.findByRole('region', { name: 'Saved version readiness' })
      const copy = within(panel)
      await copy.findByText(
        unavailable
          ? 'Readiness checks are unavailable for this account.'
          : 'Configuration check failed',
      )
      expect(api.to(route)).toHaveLength(1)
      if (unavailable) {
        expect(copy.queryByText('Configuration check failed')).toBeNull()
        expect(copy.queryByRole('button', { name: 'Retry checks' })).toBeNull()
      } else {
        expect(copy.queryByText('Readiness checks are unavailable for this account.')).toBeNull()
        expect(copy.getByRole('button', { name: 'Retry checks' })).toBeDefined()
      }
    },
  )

  describe.each([
    {
      locale: 'en',
      title: 'Title',
      heading: 'Saved version readiness',
      guidance: 'Your team context changed. Reload before making changes.',
      unavailable: 'Readiness checks are unavailable for this account.',
      save: 'Save changes',
      reload: 'Reload',
      prompt: LEAVE_WITH_UNSAVED_CHANGES,
    },
    {
      locale: 'zh-CN',
      title: '标题',
      heading: '已保存版本的就绪检查',
      guidance: '你的团队上下文已改变。请重新加载后再进行修改。',
      unavailable: '此账号无法使用就绪检查。',
      save: '保存更改',
      reload: '重新加载',
      prompt: '你有未保存的更改。离开此页面并放弃更改？',
    },
  ] as const)('context change recovery in $locale', (copy) => {
    it.each([false, true])(
      'offers reload with dirty=%s without implying an account restriction',
      async (dirty) => {
        chooseLanguage(copy.locale)
        const user = userEvent.setup()
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
        const api = server({
          [PATCH_ROUTE]: () =>
            json(409, {
              error: 'organization_context_changed',
              message: 'Changed server wording.',
            }),
        })
        renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
        const title = await screen.findByLabelText<HTMLInputElement>(copy.title, { exact: true })
        if (dirty) await user.type(title, ' revised')
        await user.click(screen.getByRole('button', { name: copy.save }))
        const panel = screen.getByRole('region', { name: copy.heading })
        await within(panel).findByText(copy.guidance)
        expect(within(panel).queryByText(copy.unavailable)).toBeNull()
        expect(within(panel).queryByRole('button', { name: 'Retry checks' })).toBeNull()
        expect(screen.getAllByRole('button', { name: copy.reload })).toHaveLength(1)
        expect(title.value).toBe(dirty ? 'Intro call revised' : 'Intro call')
        expect(api.to(PATCH_ROUTE)).toHaveLength(1)
        expect(api.to(TEAM_ROUTE)).toHaveLength(1)

        await user.click(within(panel).getByRole('button', { name: copy.reload }))
        await waitFor(() =>
          expect(screen.getByLabelText<HTMLInputElement>(copy.title, { exact: true }).value).toBe(
            'Intro call',
          ),
        )
        expect(api.to('GET /api/v1/me')).toHaveLength(2)
        expect(screen.queryByRole('button', { name: copy.reload })).toBeNull()
        if (dirty) expect(confirm).toHaveBeenCalledExactlyOnceWith(copy.prompt)
        else expect(confirm).not.toHaveBeenCalled()
      },
    )
  })
})
