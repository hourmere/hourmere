import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import * as react from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'
import { Field } from '../../components/forms.tsx'
import { ME } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { type oneTimeLinkError, oneTimeLinkMetadata } from './OneTimeLinks.tsx'

const source = readFileSync('apps/web/src/pages/event-types/OneTimeLinks.tsx', 'utf8')
const TOKEN_MARKER = 'mutation-capability-marker'
const URL_ONCE = `https://example.test/book/${TOKEN_MARKER}`
const i18n = () => ({ t: (text: string) => text, locale: 'en' })
const PrivateHistory = () => <p>Private history</p>
const RevokeButton = () => <button type="button">Revoke link</button>
const post = () => ({})
function UnsafeConfirmAction({
  accessibleLabel,
  onConfirm,
}: {
  accessibleLabel: string
  onConfirm: () => void
}) {
  return (
    <button type="button" aria-label={accessibleLabel} onClick={onConfirm}>
      Revoke link
    </button>
  )
}

/** Mutate only an in-memory copy of production code, then assert its rendered outcome. */
function copy<T>(code: string, name: string, dependencies: Record<string, unknown> = {}): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: code.replace(/^export /gm, ''), encoding: 'utf8' },
  )
  return new Function('reactRuntime', ...Object.keys(dependencies), `${compiled}; return ${name}`)(
    react,
    ...Object.values(dependencies),
  ) as T
}

function mutate(code: string, before: string, after: string) {
  expect(code.split(before), 'mutation must match exactly once').toHaveLength(2)
  return code.replace(before, after)
}

async function detects(
  code: string,
  before: string,
  after: string,
  assertion: (value: string) => void | Promise<void>,
) {
  await assertion(code)
  let caught: unknown
  try {
    await assertion(mutate(code, before, after))
  } catch (err) {
    caught = err
  }
  expect(caught).toMatchObject({ name: 'AssertionError' })
  await assertion(code)
}

const dialogSource = source.slice(source.indexOf('function OneTimeLinkCreated('))
type Dialog = react.ComponentType<{ url: string; onDone: () => void }>
function dialog(code: string): Dialog {
  return copy<Dialog>(code, 'OneTimeLinkCreated', {
    useI18n: i18n,
    useRef,
    useId,
    useEffect,
    Field,
    CopyButton,
  })
}

describe('one-time link UI production-source negative controls', () => {
  it('detects dropping safe creator attribution from newly created metadata', async () => {
    const code = source.slice(
      source.indexOf('export function oneTimeLinkMetadata('),
      source.indexOf('/** Server prose'),
    )
    await detects(
      code,
      'creatorDisplayName: link.creatorDisplayName,',
      'creatorDisplayName: null,',
      (value) => {
        const project = copy<typeof oneTimeLinkMetadata>(value, 'oneTimeLinkMetadata')
        const metadata = project({
          creatorDisplayName: 'Grace Hopper',
          prefill: { name: null, email: null },
        } as never)
        expect(metadata.creatorDisplayName).toBe('Grace Hopper')
      },
    )
  })

  it.each([
    [
      'member label',
      'Grace Hopper',
      'link.creatorDisplayName',
      'link.creatorUserId',
      'Grace Hopper',
    ],
    ['neutral fallback', null, "t('Unknown member')", 'link.creatorUserId', 'Unknown member'],
  ] as const)(
    'detects exposing the creator UUID instead of the %s',
    async (_case, displayName, before, after, expected) => {
      const start = source.indexOf("<dt>{t('Created by')}</dt>")
      const code = source.slice(start, source.indexOf("<dt>{t('Link expiry')}</dt>", start))
      await detects(code, before, after, (value) => {
        const Attribution = copy<react.ComponentType>(
          `function Attribution() { const link={creatorUserId:'creator-uuid',creatorDisplayName:displayName}; const t=(text)=>text; return <dl>${value}</dl> }`,
          'Attribution',
          { displayName },
        )
        const view = render(<Attribution />)
        try {
          expect(screen.getByText('Created by').nextElementSibling?.textContent).toBe(expected)
          expect(view.container.textContent).not.toContain('creator-uuid')
        } finally {
          view.unmount()
        }
      })
    },
  )

  it('detects removing the literal Chinese spacing before a revoke link id', async () => {
    const chinese = readFileSync('apps/web/src/i18n/catalogues/zh-CN/admin.ts', 'utf8')
    await detects(chinese, '撤销一次性链接 {0}', '撤销一次性链接{0}', (value) => {
      const catalogue = copy<Record<string, string>>(value, 'admin')
      expect(catalogue['Revoke one-time link {0}']).toBe('撤销一次性链接 {0}')
    })
  })

  it('detects retaining a creation URL, raw token or hash in list metadata', async () => {
    const code = source.slice(
      source.indexOf('export function oneTimeLinkMetadata('),
      source.indexOf('/** Server prose'),
    )
    await detects(code, 'id: link.id,', '...link, id: link.id,', (value) => {
      const project = copy<typeof oneTimeLinkMetadata>(value, 'oneTimeLinkMetadata')
      const metadata = project({
        prefill: { name: null, email: null },
        url: URL_ONCE,
        token: TOKEN_MARKER,
        tokenHash: TOKEN_MARKER,
      } as never)
      expect(JSON.stringify(metadata).includes(TOKEN_MARKER)).toBe(false)
    })
  })

  it('detects reflecting unknown server prose into the error surface', async () => {
    const code = source.slice(
      source.indexOf('export function oneTimeLinkError('),
      source.indexOf('/** Opening is explicit'),
    )
    await detects(
      code,
      'if (error instanceof RequestError) {',
      'if (error instanceof RequestError) return error.message; if (error instanceof RequestError) {',
      (value) => {
        const message = copy<typeof oneTimeLinkError>(value, 'oneTimeLinkError', {
          RequestError,
          isOrganizationContextChanged,
        })
        expect(
          message(new RequestError(409, 'unknown_code', URL_ONCE)).includes(TOKEN_MARKER),
        ).toBe(false)
      },
    )
  })

  it.each([
    [
      'initial focus',
      'input.current?.focus()',
      '',
      (element: HTMLElement) => {
        expect(document.activeElement).toBe(element.querySelector('input'))
      },
    ],
    [
      'modal semantics',
      'aria-modal="true"',
      'aria-modal="false"',
      (element: HTMLElement) => {
        expect(element.getAttribute('aria-modal')).toBe('true')
      },
    ],
    [
      'screen-reader warning',
      '<p id={description} role="status">',
      '<p id={description}>',
      (element: HTMLElement) => {
        expect(element.querySelector('[role="status"][id]')).not.toBeNull()
      },
    ],
    [
      'description linkage',
      'aria-describedby={description}',
      '',
      (element: HTMLElement) => {
        expect(
          document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent,
        ).toContain('URL cannot be shown again')
      },
    ],
  ] as const)(
    'detects losing %s in the copy-once dialog',
    async (_name, before, after, assertion) => {
      await detects(dialogSource, before, after, (code) => {
        const Created = dialog(code)
        const view = render(<Created url={URL_ONCE} onDone={() => {}} />)
        try {
          assertion(screen.getByRole('dialog'))
        } finally {
          view.unmount()
        }
      })
    },
  )

  it('detects losing Escape dismissal', async () => {
    await detects(dialogSource, "if (e.key === 'Escape') {", 'if (false) {', (code) => {
      const Created = dialog(code)
      let dismissed = false
      const view = render(
        <Created
          url={URL_ONCE}
          onDone={() => {
            dismissed = true
          }}
        />,
      )
      try {
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
        expect(dismissed).toBe(true)
      } finally {
        view.unmount()
      }
    })
  })

  it.each(['button', 'Escape', 'cancel'] as const)(
    'restores focus after %s dismissal and detects leaving the native modal open',
    async (method) => {
      const start = source.indexOf('{createdUrl !== null && !contextChanged && (')
      const content = source.slice(start, source.indexOf('\n    </>', start))
      await detects(dialogSource, 'element.close()', 'undefined', (code) => {
        const descriptors = {
          showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
          close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
        }
        let modal: HTMLDialogElement | null = null
        const originalFocus = HTMLElement.prototype.focus
        // jsdom has no native top layer. Model its inert background: attempts to focus
        // the opener are ignored until close(), even before React removes the dialog.
        Object.defineProperties(HTMLDialogElement.prototype, {
          showModal: {
            configurable: true,
            value(this: HTMLDialogElement) {
              modal = this
              this.setAttribute('open', '')
            },
          },
          close: {
            configurable: true,
            value(this: HTMLDialogElement) {
              modal = null
              this.removeAttribute('open')
            },
          },
        })
        const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
          this: HTMLElement,
          options?: FocusOptions,
        ) {
          if (modal?.isConnected && !modal.contains(this)) return
          originalFocus.call(this, options)
        })
        const Harness = copy<react.ComponentType>(
          `function Harness() { const [createdUrl,setCreatedUrl]=useState(URL_ONCE); const contextChanged=false; const createButton=useRef(null); return <><button type="button" ref={createButton}>Create another link</button>${content}</> }`,
          'Harness',
          {
            useState,
            useRef,
            URL_ONCE,
            OneTimeLinkCreated: dialog(code),
          },
        )
        const view = render(<Harness />)
        try {
          const element = screen.getByRole('dialog')
          expect(document.activeElement).toBe(element.querySelector('input'))
          if (method === 'button')
            fireEvent.click(screen.getByRole('button', { name: 'Close and forget URL' }))
          else if (method === 'Escape') fireEvent.keyDown(element, { key: 'Escape' })
          else fireEvent(element, new Event('cancel', { cancelable: true }))
          expect(screen.queryByRole('dialog')).toBeNull()
          expect(document.activeElement).toBe(
            screen.getByRole('button', { name: 'Create another link' }),
          )
        } finally {
          view.unmount()
          focus.mockRestore()
          for (const key of ['showModal', 'close'] as const) {
            const descriptor = descriptors[key]
            if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
            else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
          }
        }
      })
    },
  )

  it.each([
    ['reverse Tab', 'last?.focus()', 'first?.focus()', true],
    ['forward Tab', 'first?.focus()', 'last?.focus()', false],
  ] as const)('detects losing %s focus containment', async (_name, before, after, shiftKey) => {
    await detects(dialogSource, before, after, (code) => {
      const Created = dialog(code)
      const view = render(<Created url={URL_ONCE} onDone={() => {}} />)
      try {
        const element = screen.getByRole('dialog')
        const input = element.querySelector('input')
        const done = screen.getByRole('button', { name: 'Close and forget URL' })
        if (!shiftKey) done.focus()
        fireEvent.keyDown(element, { key: 'Tab', shiftKey })
        expect(document.activeElement).toBe(shiftKey ? done : input)
      } finally {
        view.unmount()
      }
    })
  })

  it('detects retaining the URL after explicit dismissal', async () => {
    const start = source.indexOf('{createdUrl !== null && !contextChanged && (')
    const code = source.slice(start, source.indexOf('\n    </>', start))
    await detects(code, 'setCreatedUrl(null)', 'setCreatedUrl(createdUrl)', (value) => {
      const Harness = copy<react.ComponentType>(
        `function Harness() { const [createdUrl,setCreatedUrl]=useState(URL_ONCE); const contextChanged=false; const createButton=useRef(null); return <>${value}</> }`,
        'Harness',
        {
          useState,
          useRef,
          URL_ONCE,
          OneTimeLinkCreated: dialog(dialogSource),
        },
      )
      const view = render(<Harness />)
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Close and forget URL' }))
        expect(screen.queryByRole('dialog')).toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects showing private history after the editor organization context changes', async () => {
    const start = source.indexOf('export function OneTimeLinks(')
    const code = source.slice(start, source.indexOf('\nfunction OneTimeLinkManager(', start))
    await detects(code, '{disabled ? (', '{false ? (', (value) => {
      const Section = copy<
        react.ComponentType<{ event: ReturnType<typeof eventType>; disabled: boolean }>
      >(value, 'OneTimeLinks', {
        useI18n: i18n,
        useMe: () => ME,
        useState,
        useId,
        OneTimeLinkManager: PrivateHistory,
      })
      const view = render(<Section event={eventType()} disabled={false} />)
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Manage one-time links' }))
        expect(screen.queryByText('Private history')).not.toBeNull()
        view.rerender(<Section event={eventType()} disabled />)
        expect(screen.queryByText('Private history')).toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects showing a create capability after the requesting editor unmounts', async () => {
    const start = source.indexOf('  async function create(')
    const code = source.slice(start, source.indexOf('\n  async function more(', start))
    await detects(code, 'if (!mounted.current) return', 'if (false) return', async (value) => {
      const calls: string[] = []
      const run = copy<() => Promise<void>>(
        `async function run() {
        const busy=false, contextChanged=false, email='', name='', expiry='';
        const mounted={current:false}, event={id:'event'}, headers={}; const attempt={current:null};
        const setError=()=>{},setStatus=()=>{},setBusy=()=>{},setRecent=()=>{},setName=()=>{},setEmail=()=>{},failure=()=>{};
        const setCreatedUrl=(value)=>calls.push(value); ${value}; await create({preventDefault(){}});
      }`,
        'run',
        {
          calls,
          randomHex: () => 'random',
          api: { POST: post },
          unwrap: async () => ({ url: URL_ONCE }),
          oneTimeLinkMetadata,
        },
      )
      await run()
      expect(calls).toHaveLength(0)
    })
  })

  it('detects re-enabling revoke for terminal link states', async () => {
    const start = source.indexOf("{link.state === 'active' && !contextChanged && (")
    const code = source.slice(start, source.indexOf('\n          </li>', start))
    await detects(code, "link.state === 'active'", 'true', (value) => {
      const Actions = copy<react.ComponentType>(
        `function Actions() { const link={id:'link',state:'used'}; const contextChanged=false; const t=(text)=>text; const revoke=()=>{}; return <>${value}</> }`,
        'Actions',
        {
          ConfirmAction: RevokeButton,
        },
      )
      const view = render(<Actions />)
      try {
        expect(screen.queryByRole('button', { name: 'Revoke link' })).toBeNull()
      } finally {
        view.unmount()
      }
    })
  })

  it('detects bypassing revoke confirmation at its production call site', async () => {
    const start = source.indexOf("{link.state === 'active' && !contextChanged && (")
    const code = source.slice(start, source.indexOf('\n          </li>', start))
    await detects(code, '<ConfirmAction', '<UnsafeConfirmAction', (value) => {
      let calls = 0
      const Actions = copy<react.ComponentType>(
        `function Actions() { const link={id:'link',state:'active'}; const contextChanged=false; const t=(text)=>text; const revoke=()=>record(); return <>${value}</> }`,
        'Actions',
        {
          ConfirmAction,
          UnsafeConfirmAction,
          record: () => {
            calls++
          },
        },
      )
      const view = render(<Actions />)
      try {
        fireEvent.click(screen.getByRole('button', { name: /Revoke one-time link/ }))
        expect(calls).toBe(0)
      } finally {
        view.unmount()
      }
    })
  })

  it('detects minting a new request key when retrying unchanged details', async () => {
    const start = source.indexOf('const fingerprint = JSON.stringify(')
    const code = source.slice(start, source.indexOf('\n    setBusy(true)', start))
    await detects(code, 'attempt.current?.fingerprint !== fingerprint', 'true', (value) => {
      let sequence = 0
      const retry = copy<() => string[]>(
        `function retry() { const expiry='', name='', email=''; const attempt={current:null}; function submit() { ${value}; return attempt.current.key }; return [submit(),submit()] }`,
        'retry',
        {
          randomHex: () => `random-${++sequence}`,
        },
      )
      const keys = retry()
      expect(keys[0]).toBe(keys[1])
    })
  })

  it('detects shortening elapsed expiry at a daylight-saving boundary', async () => {
    const start = source.indexOf('const fingerprint = JSON.stringify(')
    const code = source.slice(start, source.indexOf('\n    setBusy(true)', start))
    await detects(code, 'Number(expiry) * 3_600_000', 'Number(expiry) * 3_450_000', (value) => {
      const FrozenDate = class extends Date {
        static override now() {
          return Date.parse('2030-03-10T09:30:00Z')
        }
      }
      const frozen = copy<() => { expiresAt: string }>(
        `function body() { const expiry='24', name='', email=''; const attempt={current:null}; ${value}; return attempt.current.body }`,
        'body',
        { randomHex: () => 'random', Date: FrozenDate },
      )
      expect(Date.parse(frozen().expiresAt) - FrozenDate.now()).toBe(86_400_000)
    })
  })
})
