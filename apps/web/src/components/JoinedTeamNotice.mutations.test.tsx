import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import * as router from 'react-router'
import { describe, expect, it } from 'vitest'
import { admin } from '../i18n/admin.ts'
import * as runtime from '../i18n/runtime.tsx'
import { msg, registerCatalog } from '../i18n/translate.ts'
import * as paths from '../paths.ts'
import type { Me, Notice } from '../session.tsx'
import { ME } from '../test/fake-api.tsx'
import type { JoinedTeamNotice } from './JoinedTeamNotice.tsx'

registerCatalog(admin)

const source = readFileSync('apps/web/src/components/JoinedTeamNotice.tsx', 'utf8')
const teamMe: Me = {
  ...ME,
  organization: { id: 'joined-team', name: 'Team Alpha', slug: 'alpha', personal: false },
}
const message = 'You joined Team Alpha.'
const notice: Notice = {
  message: msg('You joined {team}.', { team: teamMe.organization.name }),
  path: paths.PATHS.eventTypes,
  joinedTeam: { userId: ME.user.id, organizationId: teamMe.organization.id },
}
interface SessionValue {
  me: Me
  notice: Notice | null
  setNotice: react.Dispatch<react.SetStateAction<Notice | null>>
}
const Session = react.createContext<SessionValue | null>(null)

/** Render changed production copies with real React/router hooks; never edit production files. */
function sourceCopy(text: string): typeof JoinedTeamNotice {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: text, encoding: 'utf8' },
  )
  const dependencies: Record<string, unknown> = {
    react,
    'react-router': router,
    '../i18n/runtime.tsx': runtime,
    '../paths.ts': paths,
    '../session.tsx': {
      useMe: () => react.useContext(Session)?.me,
      useSession: () => react.useContext(Session),
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'reactRuntime', compiled)(
    (name: string) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected source import ${name}`)
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return (module.exports as { JoinedTeamNotice: typeof JoinedTeamNotice }).JoinedTeamNotice
}

function Harness({
  Copy,
  initialMe,
  initialNotice,
}: {
  Copy: typeof JoinedTeamNotice
  initialMe: Me
  initialNotice: Notice
}) {
  const [currentNotice, setNotice] = react.useState<Notice | null>(initialNotice)
  const [shown, setShown] = react.useState(true)
  const navigate = router.useNavigate()
  return (
    <Session value={{ me: initialMe, notice: currentNotice, setNotice }}>
      {shown && <Copy />}
      <output data-testid="shared-join-notice">{JSON.stringify(currentNotice)}</output>
      <router.Link to={`${paths.PATHS.eventTypes}#next`}>Navigate</router.Link>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => setShown((previous) => !previous)}>
        Toggle page
      </button>
    </Session>
  )
}

function display(text: string, initialMe = teamMe, initialNotice = notice) {
  const Copy = sourceCopy(text)
  return render(
    <runtime.InterfaceScope surface="admin">
      <router.MemoryRouter initialEntries={[paths.PATHS.eventTypes]}>
        <Harness Copy={Copy} initialMe={initialMe} initialNotice={initialNotice} />
      </router.MemoryRouter>
    </runtime.InterfaceScope>,
  )
}

function mutate(text: string, before: string, after: string) {
  expect(text.split(before), 'mutation must match exactly once').toHaveLength(2)
  return text.replace(before, after)
}

async function killed(assertion: (text: string) => Promise<void>, mutated: string) {
  await assertion(source)
  await expect(assertion(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
  await assertion(source)
}

describe('joined notice production-source mutation controls', () => {
  it.each([
    ['status role', 'role="status"', 'role="alert"'],
    ['team confirmation', 'ui(joined.notice.message)', "t('Loading…')"],
    ['next-step destination', 'to={PATHS.availability}', 'to={PATHS.home}'],
  ])('detects removal of the %s', async (_, before, after) => {
    async function assertion(text: string) {
      const view = display(text)
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        expect(screen.queryByText(message)?.getAttribute('role')).toBe('status')
        expect(
          screen.queryByRole('link', { name: 'Review default availability' })?.getAttribute('href'),
        ).toBe(paths.PATHS.availability)
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, mutate(source, before, after))
  })

  it('detects a disabled dismiss action', async () => {
    async function assertion(text: string) {
      const view = display(text)
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
        expect(screen.queryByText(message)).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, mutate(source, 'onClick={() => setJoined(null)}', 'onClick={() => {}}'))
  })

  it('detects retaining the consumed handoff as a pending session message', async () => {
    async function assertion(text: string) {
      const view = display(text)
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        expect(screen.getByTestId('shared-join-notice').textContent).toBe('null')
        await userEvent.click(screen.getByRole('button', { name: 'Toggle page' }))
        await userEvent.click(screen.getByRole('button', { name: 'Toggle page' }))
        expect(screen.queryByText(message)).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      mutate(
        source,
        'setNotice(null)',
        'setNotice({ ...notice, path: null, joinedTeam: undefined })',
      ),
    )
  })

  it('detects removal of location-key binding on same-page navigation', async () => {
    async function assertion(text: string) {
      const view = display(text)
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        await userEvent.click(screen.getByRole('link', { name: 'Navigate' }))
        expect(screen.queryByText(message)).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, mutate(source, '    joined.locationKey === location.key &&\n', ''))
  })

  it('detects a notice reviving on back when navigation no longer clears local state', async () => {
    async function assertion(text: string) {
      const view = display(text)
      try {
        expect(screen.queryByText(message)).not.toBeNull()
        await userEvent.click(screen.getByRole('link', { name: 'Navigate' }))
        expect(screen.queryByText(message)).toBeNull()
        await userEvent.click(screen.getByRole('button', { name: 'Back' }))
        expect(screen.queryByText(message)).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      mutate(
        source,
        'else if (joined && !visible) setJoined(null)',
        'else if (false) setJoined(null)',
      ),
    )
  })

  it.each([
    [
      'user',
      'joined.notice.joinedTeam?.userId === me.user.id &&',
      'notice.joinedTeam.userId === me.user.id &&',
    ],
    [
      'team',
      'joined.notice.joinedTeam.organizationId === me.organization.id &&',
      'notice.joinedTeam.organizationId === me.organization.id &&',
    ],
    ['personal space', '!me.organization.personal', '!me.organization.personal'],
  ])(
    'detects allowing a joined notice for a different %s',
    async (field, visibleGuard, consumeGuard) => {
      const invalidMe =
        field === 'user'
          ? { ...teamMe, user: { ...ME.user, id: 'another-user' } }
          : field === 'team'
            ? { ...teamMe, organization: { ...teamMe.organization, id: 'another-team' } }
            : { ...teamMe, organization: { ...teamMe.organization, personal: true } }
      async function assertion(text: string) {
        const view = display(text, invalidMe)
        try {
          expect(screen.queryByText(message)).toBeNull()
          expect(screen.getByTestId('shared-join-notice').textContent).toBe('null')
        } finally {
          view.unmount()
        }
      }
      const mutated =
        field === 'personal space'
          ? source.replaceAll(visibleGuard, 'true')
          : mutate(mutate(source, visibleGuard, ''), consumeGuard, '')
      if (field === 'personal space') expect(source.split(visibleGuard)).toHaveLength(3)
      await killed(assertion, mutated)
    },
  )

  it('detects consuming a join handoff intended for another landing page', async () => {
    async function assertion(text: string) {
      const view = display(text, teamMe, { ...notice, path: paths.PATHS.availability })
      try {
        expect(screen.queryByText(message)).toBeNull()
        expect(screen.getByTestId('shared-join-notice').textContent).toBe('null')
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, mutate(source, 'notice.path === location.pathname &&', ''))
  })
})
