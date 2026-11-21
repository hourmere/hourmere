import type { Dialog, Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as englishAdmin } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { common as englishCommon } from '../../apps/web/src/i18n/catalogues/en/common.ts'
import { admin as chineseAdmin } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { common as chineseCommon } from '../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import { PATHS, routingFormPath } from '../../apps/web/src/paths.ts'
import { spaceCjkBoundaries } from '../../packages/core/src/language.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

const english = { ...englishCommon, ...englishAdmin }
const chinese = { ...chineseCommon, ...chineseAdmin }

export const routingFormManagerAuditPages = [
  { id: 'routing-manager-off', title: 'Routing manager unavailable while off' },
  { id: 'routing-manager-list', title: 'Routing form list' },
  { id: 'routing-manager-team-list', title: 'Team routing form list' },
  { id: 'routing-manager-list-empty', title: 'Empty routing form list' },
  { id: 'routing-manager-list-loading', title: 'Routing form list loading' },
  { id: 'routing-manager-list-denied', title: 'Routing form list without permission' },
  { id: 'routing-manager-list-error', title: 'Routing form list load error' },
  { id: 'routing-manager-new', title: 'New routing form' },
  { id: 'routing-manager-creation-retry', title: 'Unconfirmed routing form creation' },
  { id: 'routing-manager-edit', title: 'Routing question and option editor' },
  { id: 'routing-manager-edit-loading', title: 'Routing form draft loading' },
  { id: 'routing-manager-edit-denied', title: 'Routing form draft without permission' },
  { id: 'routing-manager-edit-error', title: 'Routing form draft load error' },
  { id: 'routing-manager-edit-missing', title: 'Unavailable routing form draft' },
  { id: 'routing-manager-context-changed', title: 'Routing form space changed' },
  { id: 'routing-manager-invalid', title: 'Routing form validation errors' },
  { id: 'routing-manager-saving', title: 'Routing form save in progress' },
  { id: 'routing-manager-saved', title: 'Routing draft saved' },
  { id: 'routing-manager-save-error', title: 'Routing form save error' },
  { id: 'routing-manager-stale', title: 'Routing form draft revision conflict' },
  { id: 'routing-manager-archive-confirm', title: 'Confirm routing form archive' },
  { id: 'routing-manager-archiving', title: 'Routing form archive in progress' },
  { id: 'routing-manager-archive-error', title: 'Routing form archive error' },
  { id: 'routing-manager-rules', title: 'Team routing rules, hidden event mappings and preview' },
  { id: 'routing-manager-rules-targets-loading', title: 'Routing event types and preview loading' },
  {
    id: 'routing-manager-rules-targets-denied',
    title: 'Routing event types and preview without permission',
  },
  {
    id: 'routing-manager-rules-targets-error',
    title: 'Routing event types and preview request errors',
  },
  {
    id: 'routing-manager-rules-targets-empty',
    title: 'No eligible event types and preview fallback',
  },
  { id: 'routing-manager-rules-fields-loading', title: 'Routing booking fields loading' },
  { id: 'routing-manager-rules-fields-denied', title: 'Routing booking fields without permission' },
  {
    id: 'routing-manager-rules-fields-error',
    title: 'Routing booking field error and stale preview',
  },
  { id: 'routing-manager-rules-invalid-mapping', title: 'Routing answer mapping validation error' },
  { id: 'routing-manager-publication-review', title: 'Saved routing fallback review' },
  { id: 'routing-manager-publication-pending', title: 'Routing publication in progress' },
  { id: 'routing-manager-publication-published', title: 'Routing publication confirmation' },
  { id: 'routing-manager-publication-disable', title: 'Acknowledge disabling the routing form' },
  {
    id: 'routing-manager-publication-disabled',
    title: 'Routing form disabled and re-enable review',
  },
  { id: 'routing-manager-publication-repair', title: 'Published routing target health and repair' },
  { id: 'routing-manager-publication-conflict', title: 'Routing publication revision conflict' },
  { id: 'routing-manager-publication-denied', title: 'Routing publication without permission' },
  { id: 'routing-manager-publication-error', title: 'Unconfirmed routing publication' },
] as const

export type RoutingFormManagerAuditPageId = (typeof routingFormManagerAuditPages)[number]['id']
type PublicationAuditPageId = Extract<
  RoutingFormManagerAuditPageId,
  `routing-manager-publication-${string}`
>
type RoutingRecord = components['schemas']['RoutingForm']
type Translate = (key: keyof typeof english & keyof typeof chinese, number?: number) => string

export function isRoutingFormManagerAuditPage(id: string): id is RoutingFormManagerAuditPageId {
  return routingFormManagerAuditPages.some((entry) => entry.id === id)
}

function isPublicationAuditPage(id: RoutingFormManagerAuditPageId): id is PublicationAuditPageId {
  return id.startsWith('routing-manager-publication-')
}

export function usesTeamRoutingFormManagerAuditSpace(id: RoutingFormManagerAuditPageId) {
  return (
    id === 'routing-manager-team-list' ||
    id.startsWith('routing-manager-rules') ||
    isPublicationAuditPage(id)
  )
}

const activeMocks = new WeakMap<Page, () => Promise<void>>()

export async function leaveRoutingFormManagerAudit(page: Page, origin: string) {
  const release = activeMocks.get(page)
  if (!release) return
  // Finish scanning unsaved drafts and pending requests before leaving their document.
  const handleDialog = (dialog: Dialog) =>
    dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
  page.on('dialog', handleDialog)
  try {
    await page.goto(`${origin}/favicon.svg`)
  } finally {
    page.off('dialog', handleDialog)
    activeMocks.delete(page)
    await release()
  }
}

const summary = {
  id: '72100000-0000-4000-8000-000000000001',
  slug: 'appointment-enquiries',
  title: 'Appointment enquiries / 预约咨询',
  draftRevision: 2,
  enabled: false,
  publishedVersionId: null,
  publishedVersionNumber: null,
  createdAt: AUDIT_NOW,
  updatedAt: AUDIT_NOW,
  health: null,
} satisfies components['schemas']['RoutingFormList']['data'][number]
const topicQuestionId = '72100000-0000-4000-8000-000000000002'
const newProjectId = '72100000-0000-4000-8000-000000000003'
const existingProjectId = '72100000-0000-4000-8000-000000000004'
const contactQuestionId = '72100000-0000-4000-8000-000000000005'
const firstRuleId = '72100000-0000-4000-8000-000000000006'
const secondRuleId = '72100000-0000-4000-8000-000000000007'
const hiddenEventId = '72100000-0000-4000-8000-000000000008'
const listedEventId = '72100000-0000-4000-8000-000000000009'
const publishedVersionId = '72100000-0000-4000-8000-000000000012'
const removedEventId = '72100000-0000-4000-8000-000000000013'
const unavailableSummary = {
  ...summary,
  enabled: true,
  publishedVersionId,
  publishedVersionNumber: 1,
  health: 'unavailable',
} as const
const unknownHealthSummary = {
  ...unavailableSummary,
  id: '72100000-0000-4000-8000-000000000014',
  title: 'Appointment follow-up / 预约后续安排',
  slug: 'appointment-follow-up',
  publishedVersionId: '72100000-0000-4000-8000-000000000015',
  health: 'unknown',
} as const
const topicQuestionLabel = 'What would you like to discuss? / 你希望讨论什么？'
const listedEventTitle = 'Support with the coordinator / 由协调员提供支持'

const draft: RoutingRecord = {
  ...summary,
  description: 'Tell us what you would like to discuss. / 请告诉我们你希望讨论什么。',
  questions: [
    {
      id: topicQuestionId,
      type: 'select',
      label: topicQuestionLabel,
      required: true,
      options: [
        { id: newProjectId, label: 'New project / 新项目' },
        { id: existingProjectId, label: 'Existing project / 现有项目' },
      ],
    },
    {
      id: contactQuestionId,
      type: 'email',
      label: 'Contact email / 联系邮箱',
      required: false,
    },
  ],
  rules: [],
  fallback: { kind: 'message', message: 'Please contact the office. / 请联系办公室。' },
}

function rulesDraft(id: RoutingFormManagerAuditPageId): RoutingRecord {
  const firstRule: RoutingRecord['rules'][number] = {
    id: firstRuleId,
    conditions: [{ questionId: topicQuestionId, operator: 'equals', value: newProjectId }],
    target: {
      kind: 'event',
      eventTypeId: hiddenEventId,
      mappings: [
        {
          questionId: topicQuestionId,
          destination: { kind: 'question', questionId: 'project-topic' },
          options: {
            [newProjectId]:
              id === 'routing-manager-rules-invalid-mapping' ? 'Old category' : 'Discovery',
            [existingProjectId]: 'Support',
          },
        },
        { questionId: contactQuestionId, destination: { kind: 'inviteeEmail' } },
      ],
    },
  }
  return {
    ...draft,
    rules:
      id === 'routing-manager-rules'
        ? [
            firstRule,
            {
              id: secondRuleId,
              conditions: [
                {
                  questionId: topicQuestionId,
                  operator: 'one_of',
                  values: [newProjectId, existingProjectId],
                },
              ],
              target: { kind: 'message', message: 'The team will be in touch. / 团队会与你联系。' },
            },
          ]
        : [firstRule],
  }
}

function publishedRecord(record: RoutingRecord, enabled: boolean): RoutingRecord {
  const targets: NonNullable<RoutingRecord['health']>['targets'] = [
    ...record.rules.map(({ id, target }) => ({ id, target })),
    { id: 'fallback', target: record.fallback },
  ].map(({ id, target }) => {
    const unavailable = target.kind === 'event' && target.eventTypeId === removedEventId
    return {
      ruleId: id,
      eventTypeId: target.kind === 'event' ? target.eventTypeId : null,
      health: unavailable ? 'unavailable' : 'ok',
      reason: unavailable ? 'not_found' : null,
    }
  })
  return {
    ...record,
    enabled,
    draftRevision: record.draftRevision + 1,
    publishedVersionId,
    publishedVersionNumber: 1,
    health: {
      versionId: publishedVersionId,
      status: targets.some(({ health }) => health === 'unavailable') ? 'unavailable' : 'ok',
      targets,
    },
  }
}

function publicationDraft(id: PublicationAuditPageId): RoutingRecord {
  const record = rulesDraft(id)
  if (id === 'routing-manager-publication-disable' || id === 'routing-manager-publication-disabled')
    return publishedRecord(record, true)
  if (id === 'routing-manager-publication-repair') {
    const fallback: RoutingRecord['fallback'] = {
      kind: 'event',
      eventTypeId: removedEventId,
      mappings: [],
    }
    return publishedRecord(
      {
        ...record,
        rules: record.rules.map((rule) => ({ ...rule, target: fallback })),
        fallback,
      },
      true,
    )
  }
  if (id === 'routing-manager-publication-review') {
    return { ...record, fallback: { kind: 'event', eventTypeId: listedEventId, mappings: [] } }
  }
  return record
}

function auditEventTypes(organizationId: string): components['schemas']['EventType'][] {
  const hidden: components['schemas']['EventType'] = {
    id: hiddenEventId,
    organizationId,
    ownerUserId: null,
    title: 'Discovery with the project lead / 与项目负责人交流',
    slug: 'lead-discovery',
    description: null,
    bookingMode: 'individual',
    groupCapacity: null,
    schedulingType: 'individual',
    hosts: [{ userId: '72100000-0000-4000-8000-000000000010' }],
    allowedDurationsMinutes: [30],
    durationMinutes: 30,
    slotStepMinutes: null,
    bookingWindowDays: null,
    bufferAfterMinutes: 0,
    bufferBeforeMinutes: 0,
    cancelCutoffMinutes: null,
    conferenceOrganizer: null,
    isActive: true,
    isHidden: true,
    allowGuests: false,
    smsRemindersEnabled: false,
    location: null,
    locations: null,
    maxBookingsPerDay: null,
    maxBookingsPerWeek: null,
    maxBookingsPerMonth: null,
    minimumNoticeMinutes: 0,
    notifications: { reminders: [], followUps: [] },
    position: 0,
    questions: [
      {
        id: 'project-topic',
        type: 'select',
        label: 'Project category / 项目类别',
        required: true,
        options: ['Discovery', 'Support'],
      },
    ],
    rescheduleCutoffMinutes: null,
    roundRobinActive: false,
    scheduleId: null,
    waitlist: { enabled: false },
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
  }
  return [
    hidden,
    {
      ...hidden,
      id: listedEventId,
      title: listedEventTitle,
      slug: 'coordinator-support',
      hosts: [{ userId: '72100000-0000-4000-8000-000000000011' }],
      isHidden: false,
      position: 1,
      questions: [],
    },
  ]
}

function previewResult(
  id: RoutingFormManagerAuditPageId,
  record: RoutingRecord,
): components['schemas']['RoutingFormPreview'] {
  const fallback = id === 'routing-manager-rules-targets-empty'
  const matched = record.rules.find(({ id }) => id === firstRuleId)
  if (!matched) throw new Error('Missing synthetic rule for preview')
  return {
    draftRevision: record.draftRevision + Number(id === 'routing-manager-rules-fields-error'),
    matchedRuleId: firstRuleId,
    resolvedRuleId: fallback ? 'fallback' : firstRuleId,
    target: fallback ? record.fallback : matched.target,
    rules: [
      {
        ruleId: firstRuleId,
        matched: true,
        conditions: [{ questionId: topicQuestionId, matched: true }],
      },
    ],
    unavailableTargets: fallback ? [{ ruleId: firstRuleId, reason: 'not_found' }] : [],
  }
}

async function openPublicationState(page: Page, id: PublicationAuditPageId, t: Translate) {
  const main = page.getByRole('main')
  const panel = main.getByTestId('routing-publication')
  const status = panel.getByRole('status')
  if (id === 'routing-manager-publication-repair') {
    const health = panel.getByTestId('routing-published-health')
    await health
      .getByRole('button', {
        name: t('Repair rule {number}', 1),
        exact: true,
      })
      .waitFor()
    await health.getByRole('button', { name: t('Repair fallback'), exact: true }).press('Enter')
    await main.locator('[id="fallback.kind"]:focus').waitFor()
    return
  }
  if (
    id === 'routing-manager-publication-disable' ||
    id === 'routing-manager-publication-disabled'
  ) {
    await panel.getByRole('button', { name: t('Disable routing form'), exact: true }).press('Enter')
    const confirmation = panel.getByTestId('routing-disable-confirmation')
    const acknowledgement = confirmation.getByRole('checkbox', {
      name: t(
        'I understand that while this form is disabled, submissions and pending booking links are blocked.',
      ),
    })
    await acknowledgement.waitFor()
    if (id === 'routing-manager-publication-disabled') {
      await acknowledgement.press('Space')
      await confirmation
        .getByRole('button', { name: t('Disable form'), exact: true })
        .press('Enter')
      await status.getByText(t('Routing form disabled.'), { exact: true }).waitFor()
      await panel
        .getByRole('button', { name: t('Re-enable routing form'), exact: true })
        .press('Enter')
      await panel.getByTestId('routing-enable-confirmation').waitFor()
    }
    return
  }

  if (id === 'routing-manager-publication-published') {
    await main.getByLabel(topicQuestionLabel, { exact: true }).selectOption(newProjectId)
    await main.getByRole('button', { name: t('Run preview'), exact: true }).press('Enter')
    await main.getByTestId('routing-preview-result').waitFor()
  }
  await panel.getByRole('button', { name: t('Review publication'), exact: true }).press('Enter')
  const review = panel.getByTestId('routing-publication-review')
  await review.waitFor()
  if (id === 'routing-manager-publication-review') {
    await review.getByText(listedEventTitle, { exact: true }).waitFor()
    return
  }
  await review.getByRole('button', { name: t('Publish version'), exact: true }).press('Enter')
  switch (id) {
    case 'routing-manager-publication-pending':
      await panel
        .getByTestId('routing-publication-pending')
        .getByText(t('Publishing…'), { exact: true })
        .waitFor()
      break
    case 'routing-manager-publication-published':
      await status.getByText(t('Published version {number}.', 1), { exact: true }).waitFor()
      break
    case 'routing-manager-publication-conflict':
      await main.getByRole('button', { name: t('Reload'), exact: true }).waitFor()
      break
    case 'routing-manager-publication-denied':
      await main.getByText(t("You don't have permission to do that."), { exact: true }).waitFor()
      break
    case 'routing-manager-publication-error':
      await main
        .getByText(
          t('Could not confirm publication. Try publishing again to recover the result.'),
          { exact: true },
        )
        .waitFor()
      break
  }
}

export async function openRoutingFormManagerAuditPage(
  page: Page,
  app: FixtureApp,
  id: RoutingFormManagerAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const t: Translate = (key, number) => {
    const template = locale === 'zh-CN' ? chinese[key] : english[key]
    if (number === undefined) return template
    return template.replace('{number}', (placeholder, start: number) =>
      locale === 'zh-CN'
        ? spaceCjkBoundaries(
            template.slice(0, start),
            String(number),
            template.slice(start + placeholder.length),
          )
        : String(number),
    )
  }
  const fixture = await app.auditState()
  const rules = id.startsWith('routing-manager-rules')
  const publication = isPublicationAuditPage(id)
  const withEvents = rules || publication
  const record = publication ? publicationDraft(id) : rules ? rulesDraft(id) : draft
  const list = id.includes('-list') || id === 'routing-manager-off'
  const summaries =
    id === 'routing-manager-team-list'
      ? [unavailableSummary, unknownHealthSummary]
      : id.endsWith('-empty')
        ? []
        : [summary]
  const creating = id === 'routing-manager-new' || id === 'routing-manager-creation-retry'
  const loading = !withEvents && id.endsWith('-loading')
  const pending = loading || id === 'routing-manager-saving' || id === 'routing-manager-archiving'
  const pendingRules = rules && id.endsWith('-loading')
  const dirty = id === 'routing-manager-invalid' || id === 'routing-manager-creation-retry'
  const path = list
    ? PATHS.routingForms
    : creating
      ? PATHS.newRoutingForm
      : routingFormPath(record.id, withEvents ? fixture.teamOrganizationId : fixture.organizationId)
  const apiPath = `/api/v1/routing-forms${list || creating ? '' : `/${record.id}`}`
  const matchesDraft = (url: URL) => url.origin === app.url && url.pathname === apiPath
  const matchesPreview = (url: URL) =>
    url.origin === app.url && url.pathname === `${apiPath}/preview`
  const matchesPublish = (url: URL) =>
    url.origin === app.url && url.pathname === `${apiPath}/publish`
  const handleDraft = async (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      if (loading) return
      if (!withEvents && id.endsWith('-denied'))
        return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
      if (id.endsWith('-missing'))
        return route.fulfill({ status: 404, json: { error: 'routing_form_not_found' } })
      if (id === 'routing-manager-context-changed')
        return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
      if (id.endsWith('-error') && (id.includes('-list') || id.includes('-edit')))
        return route.abort()
      return route.fulfill({
        json: list ? { data: summaries, nextCursor: null } : record,
      })
    }
    if (pending) return
    if (id === 'routing-manager-saved')
      return route.fulfill({ json: { ...record, draftRevision: record.draftRevision + 1 } })
    if (id === 'routing-manager-stale')
      return route.fulfill({ status: 409, json: { error: 'routing_revision_conflict' } })
    if (id === 'routing-manager-publication-disabled' && method === 'PATCH') {
      const body = route.request().postDataJSON()
      if (body.expectedRevision === record.draftRevision && body.enabled === false)
        return route.fulfill({
          json: { ...record, enabled: false, draftRevision: record.draftRevision + 1 },
        })
    }
    return route.abort()
  }
  const events = withEvents ? auditEventTypes(fixture.teamOrganizationId) : []
  const eventListUrl = `${app.url}/api/v1/event-types`
  const matchesEventDetail = (url: URL) =>
    url.origin === app.url &&
    events.some((event) => url.pathname === `/api/v1/event-types/${event.id}`)
  const denied = (route: Route) =>
    route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
  const handleEventList = async (route: Route) => {
    if (id === 'routing-manager-rules-targets-loading') return
    if (id === 'routing-manager-rules-targets-denied') return denied(route)
    if (id === 'routing-manager-rules-targets-error') return route.abort()
    return route.fulfill({
      json: { data: id === 'routing-manager-rules-targets-empty' ? [] : events },
    })
  }
  const handleEventDetail = async (route: Route) => {
    if (id === 'routing-manager-rules-fields-loading') return
    if (id === 'routing-manager-rules-fields-denied') return denied(route)
    if (id === 'routing-manager-rules-fields-error') return route.abort()
    return route.fulfill({
      json: events.find((event) => new URL(route.request().url()).pathname.endsWith(event.id)),
    })
  }
  const handlePreview = async (route: Route) => {
    if (id === 'routing-manager-rules-targets-loading') return
    if (id === 'routing-manager-rules-targets-denied') return denied(route)
    if (id === 'routing-manager-rules-targets-error') return route.abort()
    return route.fulfill({ json: previewResult(id, record) })
  }
  const handlePublish = async (route: Route) => {
    const request = route.request()
    if (
      request.method() !== 'POST' ||
      request.headers()['x-expected-organization-id'] !== fixture.teamOrganizationId ||
      request.postDataJSON()?.expectedRevision !== record.draftRevision
    )
      return route.abort()
    if (id === 'routing-manager-publication-pending') return
    if (id === 'routing-manager-publication-conflict')
      return route.fulfill({ status: 409, json: { error: 'routing_revision_conflict' } })
    if (id === 'routing-manager-publication-denied') return denied(route)
    if (id === 'routing-manager-publication-error')
      return route.fulfill({ status: 503, json: { error: 'service_unavailable' } })
    return route.fulfill({
      status: 201,
      json: {
        form: publishedRecord(record, record.enabled),
        version: {
          id: publishedVersionId,
          formId: record.id,
          versionNumber: 1,
          questions: record.questions,
          rules: record.rules,
          fallback: record.fallback,
          publishedAt: AUDIT_NOW,
        },
      } satisfies components['schemas']['RoutingFormPublication'],
    })
  }
  const instanceUrl = `${app.url}/api/v1/instance`
  const handleInstance = (route: Route) =>
    route.fulfill({
      json: {
        hostedSignupUrl: 'https://hourmere.com',
        publicUrl: app.url,
        routingFormsEnabled: id !== 'routing-manager-off',
        signIn: { email: true, google: false, microsoft: false },
      } satisfies components['schemas']['Instance'],
    })
  const release = async () => {
    await page.unroute(instanceUrl, handleInstance)
    await page.unroute(matchesDraft, handleDraft)
    if (withEvents) {
      await page.unroute(eventListUrl, handleEventList)
      await page.unroute(matchesEventDetail, handleEventDetail)
      await page.unroute(matchesPreview, handlePreview)
    }
    if (publication) await page.unroute(matchesPublish, handlePublish)
  }

  try {
    await page.route(instanceUrl, handleInstance)
    await page.route(matchesDraft, handleDraft)
    if (withEvents) {
      await page.route(eventListUrl, handleEventList)
      await page.route(matchesEventDetail, handleEventDetail)
      await page.route(matchesPreview, handlePreview)
    }
    if (publication) await page.route(matchesPublish, handlePublish)
    if (pending || dirty || pendingRules || id === 'routing-manager-publication-pending')
      activeMocks.set(page, release)
    await Promise.all([
      loading && page.waitForRequest((request) => matchesDraft(new URL(request.url()))),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    const prefix = list ? 'routing-forms' : 'routing-form'
    if (id === 'routing-manager-off') {
      await main.getByRole('heading', { name: t('Page not found') }).waitFor()
    } else if (id === 'routing-manager-context-changed') {
      await main.getByText(t('Your team context changed. Reload before making changes.')).waitFor()
    } else if (list || loading || id.includes('-edit-')) {
      await main.getByTestId(`${prefix}-${id.split('-').at(-1)}`).waitFor()
      if (id === 'routing-manager-team-list') {
        await main.getByText(t('Health unknown'), { exact: false }).waitFor()
      }
    } else {
      const editor = main.getByTestId('routing-form-editor')
      await editor.waitFor()
      const save = editor.getByRole('button', { name: t('Save draft'), exact: true })
      if (publication) {
        await openPublicationState(page, id, t)
      } else if (rules) {
        if (id.includes('-targets-')) {
          await editor.getByTestId(`routing-event-types-${id.split('-').at(-1)}`).waitFor()
        } else if (id.includes('-fields-')) {
          await editor.getByTestId(`routing-booking-fields-${id.split('-').at(-1)}`).waitFor()
        } else {
          await editor.getByTestId('routing-answer-mappings').waitFor()
        }

        if (id === 'routing-manager-rules-invalid-mapping') {
          await save.press('Enter')
          await editor.locator('[id="rules.0.target.mappings.0.options-error"]').waitFor()
        } else if (
          id !== 'routing-manager-rules-fields-loading' &&
          id !== 'routing-manager-rules-fields-denied'
        ) {
          await main.getByLabel(topicQuestionLabel, { exact: true }).selectOption(newProjectId)
          await main.getByRole('button', { name: t('Run preview'), exact: true }).press('Enter')
          const status =
            id === 'routing-manager-rules' || id === 'routing-manager-rules-targets-empty'
              ? 'result'
              : id === 'routing-manager-rules-fields-error'
                ? 'stale'
                : id.split('-').at(-1)
          await main.getByTestId(`routing-preview-${status}`).waitFor()
        }
      } else if (id === 'routing-manager-invalid') {
        await editor.getByLabel(t('Title'), { exact: true }).fill('')
        await save.press('Enter')
        await editor
          .getByRole('alert')
          .getByRole('link', { name: t('Enter a title.') })
          .waitFor()
      } else if (id === 'routing-manager-creation-retry') {
        await editor.getByLabel(t('Title'), { exact: true }).fill(draft.title)
        await editor.getByLabel(t('Form address'), { exact: true }).fill(draft.slug)
        await save.press('Enter')
        await editor
          .getByText(t('Could not confirm creation. Try again to recover this draft.'))
          .waitFor()
      } else if (id.includes('-archive-') || id === 'routing-manager-archiving') {
        await main
          .getByRole('button', { name: t('Archive routing form'), exact: true })
          .press('Enter')
        const confirm = main.getByRole('button', { name: t('Archive form'), exact: true })
        await confirm.waitFor()
        if (id !== 'routing-manager-archive-confirm') {
          await confirm.press('Enter')
          if (pending) await main.getByRole('button', { name: t('Archiving…') }).waitFor()
          else await editor.getByText(t('Could not archive the routing form.')).waitFor()
        }
      } else if (id !== 'routing-manager-edit' && id !== 'routing-manager-new') {
        await save.press('Enter')
        if (pending) await editor.getByRole('button', { name: t('Saving…') }).waitFor()
        else if (id === 'routing-manager-saved') await editor.getByText(t('Draft saved.')).waitFor()
        else if (id === 'routing-manager-stale')
          await editor
            .getByText(
              t(
                'This routing form changed elsewhere. Reload it and review your edits before trying again.',
              ),
            )
            .waitFor()
        else await editor.getByText(t('Could not save the routing form.')).waitFor()
      }
    }
    return path
  } finally {
    if (!activeMocks.has(page)) await release()
  }
}
