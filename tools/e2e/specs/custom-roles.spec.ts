import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { eventTypePath, PATHS, workflowEditPath } from '../../../apps/web/src/paths.ts'
import { scanA11y } from '../a11y.ts'
import { expect, test } from '../custom-roles-fixtures.ts'

type Schemas = components['schemas']

async function prove(panel: Locator, nextLink: () => Promise<string>) {
  await expect(panel.getByRole('heading')).toBeFocused()
  await panel.getByRole('button', { name: /^(Send verification email|发送验证邮件)$/u }).click()
  const input = panel.getByLabel(/^(Email verification link|邮箱验证链接)$/u)
  await expect(input).toBeFocused()
  await input.fill(await nextLink())
  await panel.getByRole('button', { name: /^(Verify email link|验证邮箱链接)$/u }).click()
  await panel.getByRole('button', { name: /^(Continue|继续)$/u }).click()
}

const eventTitle = 'Coordinator consultation'
const formTitle = 'Coordinator intake'
const workflowTitle = 'Coordinator reminder'

function eventSwitch(page: Page) {
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: eventTitle, exact: true }) })
    .getByRole('switch')
}

async function seedManagedDefinitions(page: Page, url: string, teamId: string) {
  const headers = { origin: url, 'x-expected-organization-id': teamId }
  const form = await page.request.post(`${url}/api/v1/routing-forms`, {
    headers,
    data: {
      title: formTitle,
      slug: 'coordinator-intake',
      fallback: { kind: 'message', message: 'Contact the scheduling coordinator' },
    } satisfies Schemas['CreateRoutingForm'],
  })
  expect(form.status()).toBe(201)
  const workflow = await page.request.post(`${url}/api/v1/workflows`, {
    headers,
    data: {
      owner: { kind: 'team', id: teamId },
      name: workflowTitle,
      idempotencyKey: randomUUID(),
      scope: { type: 'all_event_types' },
      trigger: { type: 'before_start', offsetMinutes: 60 },
      conditions: [],
      actions: [{ type: 'email', recipients: ['booker'] }],
      enabled: false,
    } satisfies Schemas['CreateWorkflowInput'],
  })
  expect(workflow.status()).toBe(201)
  return ((await workflow.json()) as Schemas['Workflow']).id
}

test.describe('legacy controls with custom roles switched off', () => {
  test.use({ customRoleRuntime: false })

  test('fixed Admin can still manage event types, routing forms and workflows', async ({
    isMobile,
    page,
    roles,
  }) => {
    const copy = isMobile ? chinese : english
    await roles.seedTeamEvent(eventTitle)
    await roles.signIn('admin', isMobile ? 'zh-CN' : 'en')
    await seedManagedDefinitions(page, roles.url, roles.teamId)

    const main = page.getByRole('main')
    const nav = page.getByRole('navigation', { name: copy.Main, exact: true })
    const routing = nav.getByRole('link', { name: copy['Routing forms'], exact: true })
    const workflows = nav.getByRole('link', { name: copy.Workflows, exact: true })
    await page.goto(roles.url + PATHS.eventTypes)
    await expect(main.getByRole('link', { name: copy['New event type'] })).toBeVisible()
    await expect(eventSwitch(page)).toBeEnabled()
    await expect(main.getByRole('link', { name: copy['Set your weekly hours'] })).toBeVisible()

    await routing.click()
    await expect(main.getByRole('link', { name: copy['New routing form'] })).toBeVisible()
    await main.getByRole('link', { name: formTitle }).click()
    await expect(main.getByRole('button', { name: copy['Save draft'] })).toBeVisible()

    await workflows.click()
    await expect(main.getByRole('link', { name: copy['New workflow'] })).toBeVisible()
    await expect(
      main.getByRole('link', { name: copy['Edit {name}'].replace('{name}', workflowTitle) }),
    ).toBeVisible()
    await expect(
      main.getByRole('button', { name: copy['Enable {name}'].replace('{name}', workflowTitle) }),
    ).toBeEnabled()
  })
})

test('custom Member actions disappear when the same browser becomes an unrenewed Admin', async ({
  isMobile,
  page,
  roles,
}) => {
  const locale = isMobile ? 'zh-CN' : 'en'
  const copy = isMobile ? chinese : english
  const eventId = await roles.seedTeamEvent(eventTitle)
  await roles.signIn('owner', locale)
  const workflowId = await seedManagedDefinitions(page, roles.url, roles.teamId)
  await roles.grantMemberPermissions([
    'event_types.update',
    'routing_forms.read',
    'routing_forms.preview',
    'workflows.read',
    'workflows.read_runs',
    'workflows.preview',
  ])
  await roles.signIn('member', locale)
  await page.goto(roles.url + PATHS.settings)
  await page.getByRole('button', { name: copy['Verify and renew team access'] }).click()
  await prove(
    page.getByRole('region', { name: copy['Confirm your identity to renew team access.'] }),
    () => roles.proofLink(0),
  )
  await expect(
    page.getByRole('region', { name: copy['Team actions available in this browser'] }),
  ).toBeVisible()

  const main = page.getByRole('main')
  const nav = page.getByRole('navigation', { name: copy.Main, exact: true })
  const routing = nav.getByRole('link', { name: copy['Routing forms'], exact: true })
  const workflows = nav.getByRole('link', { name: copy.Workflows, exact: true })
  const newEvent = main.getByRole('link', { name: copy['New event type'] })
  const eventToggle = eventSwitch(page)
  await page.goto(roles.url + PATHS.eventTypes)
  await expect(eventToggle).toBeChecked()
  await expect(newEvent).toHaveCount(0)
  const toggled = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/v1/event-types/${eventId}`,
  )
  await eventToggle.click()
  expect((await toggled).status()).toBe(200)
  await expect(eventToggle).not.toBeChecked()

  await routing.click()
  const form = main.getByRole('link', { name: formTitle })
  await expect(form).toBeVisible()
  await expect(main.getByRole('link', { name: copy['New routing form'] })).toHaveCount(0)
  await form.click()
  const runPreview = main.getByRole('button', { name: copy['Run preview'] })
  await expect(runPreview).toBeEnabled()
  await expect(main.getByRole('button', { name: copy['Save draft'] })).toHaveCount(0)
  await runPreview.click()
  await expect(main.getByRole('heading', { name: copy['Preview result'] })).toBeVisible()
  await expect(
    main.getByTestId('routing-preview-result').getByText('Contact the scheduling coordinator', {
      exact: true,
    }),
  ).toBeVisible()

  await workflows.click()
  const details = main
    .getByRole('link', { name: copy.Details, exact: true })
    .and(main.locator(`[href="${workflowEditPath(workflowId)}"]`))
  await expect(details).toBeVisible()
  await expect(main.getByRole('link', { name: copy['New workflow'] })).toHaveCount(0)
  await expect(
    main.getByRole('button', { name: copy['Enable {name}'].replace('{name}', workflowTitle) }),
  ).toHaveCount(0)
  await main
    .getByRole('link', { name: copy['Run history for {name}'].replace('{name}', workflowTitle) })
    .click()
  await expect(main.getByText(copy['No finished runs yet.'])).toBeVisible()
  await main.getByRole('link', { name: copy.Workflows, exact: true }).click()
  await details.click()
  const preview = main.getByRole('region', { name: copy['Workflow preview'] })
  const verdict = preview.getByText(copy['The example booking matches this workflow.'], {
    exact: true,
  })
  await expect(verdict).toHaveCount(0)
  await preview.getByRole('button', { name: copy['Preview workflow'] }).click()
  await expect(verdict).toBeVisible()
  await expect(main.getByRole('button', { name: copy['Save changes'] })).toHaveCount(0)

  await roles.promoteMemberToAdmin()
  await page.goto(roles.url + PATHS.eventTypes)
  const event = main.getByRole('link', { name: eventTitle, exact: true })
  await expect(event).toBeVisible()
  await expect(main.getByRole('link', { name: copy['Set your weekly hours'] })).toBeVisible()
  await expect(main.getByRole('link', { name: copy['Renew team access'] })).toBeVisible()
  await expect(newEvent).toHaveCount(0)
  await expect(eventToggle).toHaveCount(0)
  await expect(routing).toHaveCount(0)
  await expect(workflows).toHaveCount(0)
  await page.goto(roles.url + eventTypePath(eventId))
  await expect(main.getByRole('heading', { level: 1 })).toContainText(eventTitle)
  await expect(main.getByRole('button', { name: copy['Save changes'] })).toHaveCount(0)

  await page.goto(roles.url + PATHS.routingForms)
  await expect(main.getByTestId('routing-forms-denied')).toBeVisible()
  await expect(form).toHaveCount(0)
  await expect(main.getByRole('link', { name: copy['New routing form'] })).toHaveCount(0)
  await page.goto(roles.url + PATHS.workflows)
  await expect(main.getByText(copy['Workflows are unavailable in this space.'])).toBeVisible()
  await expect(details).toHaveCount(0)
  await expect(main.getByRole('link', { name: copy['New workflow'] })).toHaveCount(0)
})

for (const locale of ['en', 'zh-CN'] as const) {
  test(`custom team roles opt-in, assignment and browser renewal in ${locale}`, async ({
    page,
    roles,
  }) => {
    const settings = `${roles.url}/app/settings`
    const root = `${roles.url}/api/v1/teams/${roles.teamId}`
    const ownerProof = page.getByRole('region', {
      name: /^(Confirm your identity before changing team roles\.|更改团队角色前，请先验证身份。)$/u,
    })
    const management = page.getByRole('region', { name: /^(Roles and permissions|角色与权限)$/u })
    const wordings = {
      enable: /^(Turn on custom roles|启用自定义角色)$/u,
      confirmEnable: /^(Confirm turning on custom roles|确认启用自定义角色)$/u,
      create: /^(Create custom role|创建自定义角色)$/u,
      name: /^(Custom role name|自定义角色名称)$/u,
      publish: /^(Create and publish role|创建并发布角色)$/u,
      brandingPreset: /^(Access preset for Branding|品牌设置的权限预设)$/u,
      assignment:
        /^(Change custom role for Fixture Member|更改自定义角色（\s*Fixture Member\s*）)$/u,
      select: /^(Custom role for this member|此成员的自定义角色)$/u,
      save: /^(Save custom role assignment|保存自定义角色分配)$/u,
      brandingRead: /^(View team branding|查看团队品牌设置)$/u,
      renewal: /^(Renew team access|重新验证团队权限)$/u,
      renew: /^(Verify and renew team access|验证并更新团队权限)$/u,
      memberProof:
        /^(Confirm your identity to renew team access\.|请验证身份以重新获取团队权限。)$/u,
      accepted: /^(Team actions available in this browser|此浏览器可执行的团队操作)$/u,
    }

    await roles.signIn('member', locale)
    await page.goto(settings)
    await expect(page.getByRole('region', { name: /^(Team members|团队成员)$/u })).toBeVisible()
    await expect(management).toHaveCount(0)
    await expect(page.getByRole('region', { name: wordings.renewal })).toHaveCount(0)
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(403)

    await roles.signIn('owner', locale)
    await page.goto(settings)
    await management.getByRole('button', { name: wordings.enable }).click()
    await management.getByRole('button', { name: wordings.confirmEnable }).click()
    await prove(ownerProof, () => roles.proofLink(0))

    const create = management.getByRole('button', { name: wordings.create })
    await create.press('Enter')
    await expect(management.getByRole('heading', { name: wordings.create })).toBeFocused()
    await management.getByLabel(wordings.name).fill('Branding Reader')
    await management.getByLabel(wordings.brandingPreset).selectOption('read')
    await expect(management.getByText(wordings.brandingRead)).toBeVisible()
    const scan = await scanA11y(page)
    expect(scan.passes).toBeGreaterThan(0)
    expect(
      scan.violations.filter(({ impact }) => ['serious', 'critical'].includes(impact ?? '')),
    ).toEqual([])
    await management.getByRole('button', { name: wordings.publish }).click()
    await prove(ownerProof, () => roles.proofLink(1))

    await expect(management.getByText('Branding Reader')).toBeVisible()
    const assignment = page.getByRole('button', { name: wordings.assignment })
    await assignment.press('Enter')
    const review = page.getByRole('region', { name: wordings.assignment })
    await expect(review.getByRole('heading')).toBeFocused()
    await review.getByLabel(wordings.select).selectOption({ label: 'Branding Reader' })
    await expect(review.getByText(wordings.brandingRead)).toBeVisible()
    await review.getByRole('button', { name: wordings.save }).click()
    await prove(ownerProof, () => roles.proofLink(2))
    await expect(assignment).toBeFocused()

    await roles.signIn('admin', locale)
    await page.goto(settings)
    await expect(page.getByRole('region', { name: /^(Team members|团队成员)$/u })).toBeVisible()
    await expect(management).toHaveCount(0)
    await expect(assignment).toHaveCount(0)
    expect((await page.request.get(`${root}/members/${roles.memberId}/custom-role`)).status()).toBe(
      403,
    )

    await roles.signIn('member', locale)
    await page.goto(settings)
    const renewal = page.getByRole('region', { name: wordings.renewal })
    await expect(renewal.getByText(wordings.brandingRead)).toBeVisible()
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(403)
    await renewal.getByRole('button', { name: wordings.renew }).click()
    await prove(page.getByRole('region', { name: wordings.memberProof }), () => roles.proofLink(3))
    await expect(
      page.getByRole('region', { name: wordings.accepted }).getByText(wordings.brandingRead),
    ).toBeVisible()
    expect((await page.request.get(`${roles.url}/api/v1/branding`)).status()).toBe(200)
    const branding = page.getByRole('region', {
      name: /^(Booking page branding|预约页面品牌设置)$/u,
    })
    await branding.getByRole('button', { name: wordings.brandingRead }).click()
    await expect(
      branding.getByRole('region', { name: /^(Booking page preview|预约页预览)$/u }),
    ).toBeVisible()
    await expect(
      branding.getByRole('form', { name: /^(Edit branding|编辑品牌设置)$/u }),
    ).toHaveCount(0)
    expect((await page.request.get(`${roles.url}/api/v1/team/bookings`)).status()).toBe(403)
    await expect(management).toHaveCount(0)
  })
}
