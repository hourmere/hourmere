import { readFileSync } from 'node:fs'
import { isPublicTeamSlug, isReservedName } from '@hourmere/core/reserved'
import { render, screen } from '@testing-library/react'
import * as react from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { parseWhole } from '../../components/forms.tsx'
import { EVENT_TYPE, PROFILE as PROFILE_RULES } from '../../limits.ts'
import * as paths from '../../paths.ts'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import { ME, PROFILE } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { validSchedule } from '../availability/valid-default.ts'
import { teamReadinessBlocksSharing } from './event-readiness.ts'
import { emptyDraft, slugify, suggestedBookingSlug } from './event-type-form.ts'
import type { SavedEventShare } from './SavedEventShare.tsx'

const editor = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
const share = readFileSync('apps/web/src/pages/event-types/SavedEventShare.tsx', 'utf8')
const shareFunction = share.slice(share.indexOf('export function SavedEventShare('))
const EmptyEmbedAction = () => null
const EmptySlotPicker = () => null

/** Only in-memory copies are mutated; the production files stay intact. */
function copy<T>(source: string, exported: string, dependencies: Record<string, unknown> = {}): T {
  const compiled = compileSourceCopy(exported, source.replace(/^export /gm, ''), {
    loader: 'tsx',
    format: 'cjs',
    jsxFactory: 'reactRuntime.createElement',
    jsxFragment: 'reactRuntime.Fragment',
  })
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return ${exported}`,
  )(react, ...Object.values(dependencies)) as T
}

function mutate(source: string, before: string, after: string) {
  expect(source.split(before), 'mutation must match exactly once').toHaveLength(2)
  return source.replace(before, after)
}

function detects(source: string, before: string, after: string, assertion: (code: string) => void) {
  assertion(source)
  expect(() => assertion(mutate(source, before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(source)
}

const suggested = form.slice(
  form.indexOf('export function suggestedBookingSlug'),
  form.indexOf('// Field ids'),
)

describe('first-run editor production-source negative controls', () => {
  it.each([
    {
      before:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: match production source literally
        '/[a-z]/.test(slug) ? slug : `${duration !== null && duration > 0 ? duration : 30}-min`',
      after: 'slug',
    },
    { before: '/[a-z]/.test(slug)', after: 'Boolean(slug)' },
  ])('detects weakening the duration fallback: $after', ({ before, after }) => {
    detects(suggested, before, after, (code) => {
      const suggest = copy<typeof suggestedBookingSlug>(code, 'suggestedBookingSlug', {
        parseWhole,
        slugify,
      })
      expect(suggest('初次沟通', '30')).toBe('30-min')
      expect(suggest('30分钟咨询', '30')).toBe('30-min')
      expect(suggest('30分钟面谈', '30')).toBe('30-min')
      expect(suggest('لقاء', '45')).toBe('45-min')
      expect(suggest('Intro call', '30')).toBe('intro-call')
    })
  })

  it('detects dropping the fallback at the title field call site', () => {
    const start = editor.indexOf('const value = e.target.value')
    const handler = editor.slice(start, editor.indexOf("setStatus('')", start))
    detects(handler, 'suggestedBookingSlug(value, d.durationMinutes)', 'slugify(value)', (code) => {
      const onTitle = copy<(title: string) => ReturnType<typeof emptyDraft>>(
        `function onTitle(inputTitle) { let result = emptyDraft(); const e = {target: {value: inputTitle}}; const slugTouched = false; const invalidateReadiness = () => {}; const setDraft = (update) => { result = update(result) }; ${code}; return result }`,
        'onTitle',
        { emptyDraft, suggestedBookingSlug, slugify },
      )
      expect(onTitle('初次沟通').slug).toBe('30-min')
    })
  })

  it('detects removing automatic duration updates and preserves manually chosen links', () => {
    const setter = editor.slice(
      editor.indexOf('function set<K'),
      editor.indexOf('async function submit('),
    )
    detects(setter, "name === 'durationMinutes' && !slugTouched", 'false', (code) => {
      const change = copy<(touched: boolean) => ReturnType<typeof emptyDraft>>(
        `function change(slugTouched) { let result = {...emptyDraft(), title: '初次沟通', slug: '30-min'}; const invalidateReadiness=()=>{}; const setStatus=()=>{}; const setDraft=(update)=>{result=update(result)}; ${code}; set('durationMinutes', '45'); return result }`,
        'change',
        { emptyDraft, suggestedBookingSlug },
      )
      expect(change(false).slug).toBe('45-min')
      expect(change(true).slug).toBe('30-min')
    })
  })

  it.each([
    { before: 'slugTouched ||', after: 'true ||' },
    { before: 'slugTouched ||', after: 'slugTouched || slugify(draft.title) ||' },
    {
      before: 'body.slug.slice(0, EVENT_TYPE.slugMaxLength - suffix.length - 1)',
      after: 'body.slug',
    },
  ])('detects losing automatic collision handling: $after', async ({ before, after }) => {
    const start = editor.indexOf('let created: EventType')
    const create = editor.slice(start, editor.indexOf('// Left meanwhile:', start))
    async function assertion(code: string) {
      for (const [title, slug] of [
        ['30分钟咨询', '30-min'],
        ['30分钟面谈', '30-min'],
        ['Intro call', 'intro-call'],
        ['a'.repeat(64), 'a'.repeat(64)],
      ]) {
        let calls = 0
        const save = copy<() => Promise<{ slug: string }>>(
          `async function save() { const body={slug:${JSON.stringify(slug)}}; const draft={title:${JSON.stringify(title)}}; const headers={}; const slugTouched=false; const setDraft=()=>{}; ${code}; return created }`,
          'save',
          {
            EVENT_TYPE,
            RequestError,
            slugify,
            randomHex: () => '1234abcd',
            unwrap: (value: unknown) => value,
            api: {
              POST: async (_path: string, options: { body: { slug: string } }) => {
                if (++calls === 1) throw new RequestError(409, 'slug_taken', 'Already used')
                return options.body
              },
            },
          },
        )
        let saved: { slug: string } | undefined
        try {
          saved = await save()
        } catch {
          // Keep the negative control's failure a real user-outcome assertion.
        }
        expect(saved?.slug).toBe(`${slug?.slice(0, 55)}-1234abcd`)
        expect(calls).toBe(2)
      }
    }
    await assertion(create)
    const mutant = mutate(create, before, after)
    await expect(assertion(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await assertion(create)
  })

  it('detects replacing a hand-edited link after a collision', async () => {
    const start = editor.indexOf('let created: EventType')
    const create = editor.slice(start, editor.indexOf('// Left meanwhile:', start))
    async function assertion(code: string) {
      let calls = 0
      const save = copy<() => Promise<{ slug: string }>>(
        `async function save() { const body={slug:'chosen-link'}; const headers={}; const slugTouched=true; const setDraft=()=>{}; ${code}; return created }`,
        'save',
        {
          EVENT_TYPE,
          RequestError,
          randomHex: () => '1234abcd',
          unwrap: (value: unknown) => value,
          api: {
            POST: async (_path: string, options: { body: { slug: string } }) => {
              if (++calls === 1) throw new RequestError(409, 'slug_taken', 'Already used')
              return options.body
            },
          },
        },
      )
      let error: unknown
      try {
        await save()
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(RequestError)
      expect(error).toMatchObject({ code: 'slug_taken' })
      expect(calls).toBe(1)
    }
    await assertion(create)
    await expect(assertion(mutate(create, 'slugTouched ||', 'false ||'))).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertion(create)
  })

  it('detects showing saved checks before the first save', () => {
    const start = editor.indexOf('{saved && (', editor.indexOf('<ErrorSummary'))
    const block = editor.slice(start, editor.indexOf('<fieldset className="form-fieldset"', start))
    detects(block, '{saved && (', '{true && (', (code) => {
      const Checks = copy<react.ComponentType<{ saved: boolean }>>(
        `function Checks({saved}) { const t=(text)=>text; const dirty=true; const contextChanged=false; return <>${code}</> }`,
        'Checks',
      )
      const view = render(<Checks saved={false} />)
      try {
        expect(screen.queryByRole('region', { name: 'Saved event checks' })).toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects losing reload recovery for an unsaved form after a context change', () => {
    const start = editor.indexOf('{!saved && contextChanged && (')
    const block = editor.slice(start, editor.indexOf('{saved && (', start))
    detects(block, '!saved && contextChanged', 'false', (code) => {
      const Recovery = copy<react.ComponentType>(
        `function Recovery() { const saved=null; const contextChanged=true; const t=(text)=>text; const confirmReload=()=>{}; return <>${code}</> }`,
        'Recovery',
      )
      const view = render(<Recovery />)
      try {
        expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects restoring a live region on the typed address', () => {
    const start = editor.indexOf('<div id="booking-link-status"')
    const block = editor.slice(start, editor.indexOf('</div>', start) + '</div>'.length)
    detects(block, 'className="hint"', 'className="hint" role="status"', (code) => {
      const Preview = copy<react.ComponentType>(
        `function Preview() { const previewUrl=null; const slugPreview='my-call'; const previewReadinessMessage=null; const ui=(text)=>text; return (${code}) }`,
        'Preview',
      )
      const view = render(<Preview />)
      try {
        expect(document.getElementById('booking-link-status')?.getAttribute('role')).toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it.each([
    {
      before:
        "schedules.length === 0\n                    ? 'You have no working hours yet. Use the setup guide to add a default schedule.'",
      after:
        "false\n                    ? 'You have no working hours yet. Use the setup guide to add a default schedule.'",
      expected: 'You have no working hours yet. Use the setup guide to add a default schedule.',
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: match production source literally
      before: '? `${PATHS.eventTypes}#personal-setup-heading`',
      after: '? PATHS.newSchedule',
      expected: '/app/event-types#personal-setup-heading',
    },
  ])('detects a lost no-schedule repair: $expected', ({ before, after, expected }) => {
    detects(shareFunction, before, after, (code) => {
      const Share = copy<typeof SavedEventShare>(code, 'SavedEventShare', {
        EventEmbedAction: EmptyEmbedAction,
        HostSlotPicker: EmptySlotPicker,
        verifySlotPickerAccess: async () => {},
        ...paths,
        useEffect,
        useRef,
        useState,
        useLoad: () => [{ status: 'loading' }],
        loadInstance: () => {},
        Link,
        CopyButton,
        isPublicTeamSlug,
        isReservedName,
        PROFILE: PROFILE_RULES,
        validSchedule,
        teamReadinessBlocksSharing,
        useI18n: () => ({ t: (text: string) => text }),
        useTeamManagementAccess: () => ({ status: 'ready', role: 'owner' }),
      })
      const view = render(
        <MemoryRouter>
          <Share
            event={eventType()}
            me={ME}
            profile={PROFILE}
            schedules={[]}
            readiness={{ status: 'unchecked' }}
            retryReadiness={() => {}}
          />
        </MemoryRouter>,
      )
      try {
        if (expected.startsWith('/')) {
          expect(
            screen
              .getByRole('link', { name: 'Set working hours with the setup guide' })
              .getAttribute('href'),
          ).toBe(expected)
        } else expect(screen.queryByText(expected)).not.toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it.each(['en', 'zh-CN'] as const)('detects losing the clearer question limit in %s', (locale) => {
    const source = readFileSync(`apps/web/src/i18n/catalogues/${locale}/admin.ts`, 'utf8')
    const expected =
      locale === 'en'
        ? 'Invitees always give their name and email. You can add up to {count} extra questions.'
        : '受邀人始终需要提供姓名和邮箱。你还可以添加最多{count}个问题。'
    detects(source, `    '${expected}',`, "    '最多 {count}。',", (code) => {
      const admin = copy<Record<string, string>>(code, 'admin')
      expect(
        admin[
          'Invitees always give their name and email. Add questions for anything else you need to know, up to {count}.'
        ],
      ).toBe(expected)
    })
  })
})

it('detects hiding the additional location options notice', () => {
  const start = editor.indexOf('            {(saved?.locations?.length ?? 0) > 1 && (')
  const end = editor.indexOf('            <LocationFields', start)
  expect(start).toBeGreaterThan(0)
  const notice = editor.slice(start, end)
  detects(notice, '(saved?.locations?.length ?? 0) > 1', 'false', (code) => {
    const Component = copy<() => react.ReactNode>(
      `function Notice() { return <>${code}</> }`,
      'Notice',
      {
        saved: { locations: [{ id: 'a' }, { id: 'b' }] },
        t: (text: string, args: Record<string, number>) => text.replace('{0}', String(args['0'])),
      },
    )
    const view = render(<Component />)
    try {
      expect(view.container.textContent?.trim()).toBe(
        '2 location options are configured. Manage them through REST, MCP or CLI. Saving other fields keeps these options.',
      )
    } finally {
      view.unmount()
    }
  })
})
