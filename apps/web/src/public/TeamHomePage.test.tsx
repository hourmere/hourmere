import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter } from 'react-router'
import { beforeAll, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import type { Schemas } from '../api/client.ts'
import { fakeApi, json, later, type Routes, renderApp } from '../test/fake-api.tsx'
import { accessibleNameParts, EVENT, slotsAnswer } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'

const slug = 'ResearchTeam'
const home = `/team/${slug}`
const endpoint = `/api/v1/public/teams/${slug}`
const read = `GET ${endpoint}`
const address = `${window.location.origin}${home}`
const team = { name: `青山${'InternationalResearch'.repeat(8)}`, slug }
const intro = {
  slug: 'intro',
  title: `团队交流${'Consultation'.repeat(10)}`,
  description: `预约说明${'unbroken'.repeat(16)}`,
  durationMinutes: 30,
  location: { kind: 'phone' },
} satisfies Schemas['PublicTeam']['eventTypes'][number]
const catalogue: Schemas['PublicTeam'] = {
  team,
  eventTypes: [
    intro,
    {
      slug: 'review',
      title: 'Project review',
      description: null,
      durationMinutes: 45,
      location: null,
    },
  ],
}
const empty: Schemas['PublicTeam'] = { team, eventTypes: [] }

beforeAll(async () => {
  await Promise.all([import('./TeamHomePage.tsx'), import('./BookingPage.tsx')])
})

function bookingRoutes(eventSlug: string, title: string): Routes {
  const eventEndpoint = `${endpoint}/${eventSlug}`
  return {
    [`GET ${eventEndpoint}`]: () =>
      json(200, { ...EVENT, handle: slug, slug: eventSlug, title, team }),
    [`GET ${eventEndpoint}/slots`]: slotsAnswer([]),
  }
}

function requestFor(path: string) {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => input)
    .find(
      (input): input is Request => input instanceof Request && new URL(input.url).pathname === path,
    )
}

it('publishes the exact-case address and saved event order with working booking links', async () => {
  const user = userEvent.setup()
  const api = fakeApi({
    [read]: () => json(200, catalogue),
    ...bookingRoutes(intro.slug, intro.title),
  })
  renderApp(home)
  const heading = await screen.findByRole('heading', { level: 1, name: team.name })
  const main = screen.getByRole('main')
  const list = within(main).getByRole('list')
  const links = within(list).getAllByRole('link')
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    `${home}/intro`,
    `${home}/review`,
  ])
  const introLink = within(list).getByRole('link', { name: new RegExp(intro.title) })
  expect(within(introLink).getByText(/30 min/)).toBeDefined()
  expect(within(introLink).getByText(/Phone call/)).toBeDefined()
  for (const content of [
    heading,
    within(main).getByText(address),
    within(introLink).getByText(intro.title),
    within(introLink).getByText(intro.description),
  ]) {
    expect(content.closest('.user-content')).toBe(main)
  }
  expect(api.to(read).map(({ path }) => path)).toEqual([endpoint])
  expect(requestFor(endpoint)?.credentials).toBe('omit')
  expect(requestFor(endpoint)?.headers.has('Authorization')).toBe(false)

  await user.click(introLink)
  expect(await screen.findByRole('heading', { level: 1, name: intro.title })).toBeDefined()
  expect(screen.getByTestId('location').textContent).toBe(`${home}/intro`)
  expect(api.to(`GET ${endpoint}/intro`)).toHaveLength(1)
})

it.each([
  ['en', '30 min · Phone call'],
  ['zh-CN', '30 分钟 · 电话会议'],
])('keeps a mixed-direction event link in reading order in %s', async (locale, facts) => {
  localStorage.setItem('hourmere-language', locale)
  const name = 'البحث (Research 42)'
  const title = 'שלום (Team planning)'
  const paragraphs = [
    'راجع agenda@example.invalid (Agenda).',
    'See https://room.example.invalid/42',
  ]
  fakeApi({
    [read]: () =>
      json(200, {
        team: { name, slug },
        eventTypes: [{ ...intro, title, description: paragraphs.join('\n\n') }],
      }),
  })
  renderApp(home)

  const heading = await screen.findByRole('heading', { name })
  expect(heading.querySelector('bdi')?.textContent).toBe(name)
  expect(screen.getByText(address).matches('bdi[dir="ltr"]')).toBe(true)
  const linkNameParts = [title, facts, ...paragraphs]
  const link = screen.getByRole('link', {
    name: accessibleNameParts(linkNameParts),
  })
  expect(link.getAttribute('href')).toBe(`${home}/intro`)
  expect(Array.from(link.querySelectorAll('bdi'), (value) => value.textContent)).toEqual([
    title,
    ...paragraphs,
  ])
})

it('keeps a direct, unlisted team booking link independent of directory enablement', async () => {
  const title = 'An unlisted team event'
  const api = fakeApi(bookingRoutes('unlisted', title))
  renderApp(`${home}/unlisted`)
  expect(await screen.findByRole('heading', { level: 1, name: title })).toBeDefined()
  expect(api.to(read)).toHaveLength(0)
})

it('keeps the public identity on an empty directory and localizes its message', async () => {
  const user = userEvent.setup()
  const api = fakeApi({ [read]: () => json(200, empty) })
  renderApp(home)
  await screen.findByText('This team has no public events right now.')
  const main = screen.getByRole('main')
  expect(within(main).getByRole('heading', { name: team.name, level: 1 })).toBeDefined()
  expect(within(main).getByText(address)).toBeDefined()
  expect(within(main).queryByRole('list')).toBeNull()
  await selectPublicLanguage(user, 'zh-CN')
  expect(await within(main).findByText('此团队目前没有公开活动。')).toBeDefined()
  expect(within(main).getByText(address)).toBeDefined()
  expect(api.to(read)).toHaveLength(1)
})

it('keeps the language menu focused when the directory finishes loading', async () => {
  const user = userEvent.setup()
  const pending = later()
  fakeApi({ [read]: () => pending.response })
  renderApp(home)
  await user.click(await screen.findByRole('button', { name: 'Language: English' }))
  const selectedLanguage = screen.getByRole('menuitemradio', { checked: true })
  expect(document.activeElement).toBe(selectedLanguage)
  await pending.answer(json(200, empty))
  await screen.findByRole('heading', { name: team.name, level: 1 })
  expect(document.activeElement).toBe(selectedLanguage)
  expect(screen.getByRole('menu')).toBeDefined()
})

it.each([
  ['API error', () => json(404, { error: 'team_not_found', message: team.name, ...catalogue })],
  ['bare 404', () => new Response(null, { status: 404 })],
] as const)('shows the same neutral unavailable page for an %s', async (_kind, response) => {
  fakeApi({ [read]: response })
  renderApp(home)
  const heading = await screen.findByRole('heading', {
    name: 'This team page is unavailable.',
    level: 1,
  })
  const main = screen.getByRole('main')
  expect(main.contains(heading)).toBe(true)
  expect(main.textContent).not.toContain(slug)
  expect(main.textContent).not.toContain(team.name)
  expect(main.textContent).not.toContain(intro.title)
  expect(within(main).queryByRole('link')).toBeNull()
  expect(within(main).queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(document.title).not.toContain(team.name)
})

it('does not send a request for a malformed team slug', async () => {
  const api = fakeApi({})
  renderApp('/team/not_a_team')
  expect(
    await screen.findByRole('heading', { name: 'This team page is unavailable.', level: 1 }),
  ).toBeDefined()
  expect(api.calls.some(({ path }) => path.startsWith('/api/v1/public/'))).toBe(false)
})

it.each([
  ['server error', () => json(503, { error: 'team_not_found', message: team.name })],
  ['forbidden', () => json(403, { message: team.name })],
  ['invalid response', () => json(200, { team: { ...team, slug: 'OtherTeam' }, eventTypes: [] })],
  [
    'network error',
    () => {
      throw new TypeError(team.name)
    },
  ],
] as const)(
  'shows a retryable failure for %s and recovers with a fresh read',
  async (_kind, fail) => {
    const user = userEvent.setup()
    const next = later()
    let requests = 0
    const api = fakeApi({ [read]: () => (++requests === 1 ? fail() : next.response) })
    renderApp(home)
    await screen.findByRole('heading', { name: 'Couldn’t load this team page.', level: 1 })
    const main = screen.getByRole('main')
    expect(main.textContent).not.toContain(team.name)
    expect(main.textContent).not.toContain(address)
    await user.click(within(main).getByRole('button', { name: 'Try again' }))
    expect((await within(main).findByRole('status')).textContent).toBe('Loading…')
    await next.answer(json(200, empty))
    expect(await screen.findByRole('heading', { name: team.name, level: 1 })).toBeDefined()
    expect(api.to(read)).toHaveLength(2)
  },
)

it('aborts the prior team load and discards its late response when the address changes', async () => {
  const user = userEvent.setup()
  const prior = later()
  const next = later()
  const nextTeam = { name: 'Next team', slug: 'NextTeam' }
  const api = fakeApi({
    [read]: () => prior.response,
    'GET /api/v1/public/teams/NextTeam': () => next.response,
  })
  render(
    <MemoryRouter initialEntries={[home]}>
      <Link to="/team/NextTeam">Switch team</Link>
      <App />
    </MemoryRouter>,
  )
  await waitFor(() => expect(api.to(read)).toHaveLength(1))
  const priorRequest = requestFor(endpoint)
  expect(priorRequest?.signal.aborted).toBe(false)
  await user.click(screen.getByRole('link', { name: 'Switch team' }))
  await waitFor(() => expect(api.to('GET /api/v1/public/teams/NextTeam')).toHaveLength(1))
  expect(priorRequest?.signal.aborted).toBe(true)
  await prior.answer(json(200, catalogue))
  const main = screen.getByRole('main')
  expect(within(main).getByRole('status').textContent).toBe('Loading…')
  expect(main.textContent).not.toContain(team.name)
  expect(main.textContent).not.toContain(address)
  expect(main.textContent).not.toContain(intro.title)
  await next.answer(json(200, { team: nextTeam, eventTypes: [] }))
  expect(await screen.findByRole('heading', { name: nextTeam.name, level: 1 })).toBeDefined()
})
