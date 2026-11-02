import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { embedSnippet } from '@hourmere/core/embed-snippet'
import { render, screen } from '@testing-library/react'
import * as react from 'react'
import { createPortal } from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from '../../components/CopyButton.tsx'
import { eventType } from '../../test/fixtures.ts'
import type { EventEmbedAction } from './EventEmbedAction.tsx'

const source = readFileSync('apps/web/src/pages/event-types/EventEmbedAction.tsx', 'utf8')
const dialogSource = source.slice(source.indexOf('function EventEmbedDialog('))
const DISABLED =
  'Embedding is disabled. The instance operator must set EMBED_ALLOWED_ORIGINS and restart the web process. For example:'
const UNKNOWN =
  'Embedding configuration is unavailable. Ask the instance operator to confirm allowed website origins.'

type InstanceState =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; data: { publicUrl: string; embedAllowedOrigins?: string[] } }
type Dialog = (
  props: Parameters<typeof EventEmbedAction>[0] & { onClose: () => void },
) => react.ReactNode

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(),
  })
})

/** Compile copies in memory; every negative control must fail a real rendered assertion. */
function copy(code: string, state: InstanceState): Dialog {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: code, encoding: 'utf8' },
  )
  const dependencies = {
    useEffect: react.useEffect,
    useId: react.useId,
    useRef: react.useRef,
    useState: react.useState,
    createPortal,
    embedSnippet,
    CopyButton,
    loadInstance: () => {},
    useLoad: () => [state, () => {}],
    useI18n: () => ({ t: (text: string) => text }),
  }
  return new Function(
    'reactRuntime',
    ...Object.keys(dependencies),
    `${compiled}; return EventEmbedDialog`,
  )(react, ...Object.values(dependencies)) as Dialog
}

function detects(before: string, after: string, assertion: (code: string) => void) {
  expect(dialogSource.split(before), 'mutation must match exactly once').toHaveLength(2)
  assertion(dialogSource)
  expect(() => assertion(dialogSource.replace(before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(dialogSource)
}

function assertStatus(code: string, state: InstanceState, disabled: boolean) {
  const DialogCopy = copy(code, state)
  const view = render(
    <DialogCopy event={eventType()} bookingPath="/ada/intro-call" onClose={() => {}} />,
  )
  try {
    expect(screen.queryByText(DISABLED) !== null).toBe(disabled)
    expect(screen.queryByText(UNKNOWN) !== null).toBe(!disabled)
  } finally {
    view.unmount()
  }
}

describe('embed production-source mutation controls', () => {
  it.each([
    { status: 'loading' },
    { status: 'error' },
    { status: 'ready', data: { publicUrl: 'https://schedule.example.test' } },
  ] satisfies InstanceState[])(
    'detects unknown configuration being shown as disabled: $status',
    (state) => {
      detects(
        "instance.status === 'ready' ? instance.data.embedAllowedOrigins : undefined",
        "instance.status === 'ready' ? instance.data.embedAllowedOrigins ?? [] : []",
        (code) => assertStatus(code, state, false),
      )
    },
  )

  it('detects losing the known empty-origin operator guidance', () => {
    detects('origins.length === 0', 'false', (code) =>
      assertStatus(
        code,
        {
          status: 'ready',
          data: { publicUrl: 'https://schedule.example.test', embedAllowedOrigins: [] },
        },
        true,
      ),
    )
  })

  it.each([
    {
      before: '!event.isActive ? (',
      after: 'false ? (',
      event: eventType({ isActive: false }),
      bookingPath: '/ada/intro-call',
      reason: 'This event type is inactive. Enable it and save before generating embed code.',
    },
    {
      before: '!bookingPath ? (',
      after: 'false ? (',
      event: eventType(),
      bookingPath: null,
      reason: 'Complete the saved event setup before generating embed code.',
    },
  ])(
    'detects removing code eligibility: $before → $after',
    ({ before, after, event, bookingPath, reason }) => {
      detects(before, after, (code) => {
        const DialogCopy = copy(code, {
          status: 'ready',
          data: { publicUrl: 'https://schedule.example.test', embedAllowedOrigins: [] },
        })
        const view = render(
          <DialogCopy event={event} bookingPath={bookingPath} onClose={() => {}} />,
        )
        try {
          expect(screen.queryByText(reason)).not.toBeNull()
          expect(screen.queryByLabelText('Embed code')).toBeNull()
        } finally {
          view.unmount()
        }
      })
    },
  )

  it('detects substituting the admin origin when PUBLIC_URL is absent', () => {
    detects(
      'publicUrl: instance.data.publicUrl,',
      'publicUrl: instance.data.publicUrl ?? window.location.origin,',
      (code) => {
        const DialogCopy = copy(code, {
          status: 'ready',
          data: { publicUrl: undefined as unknown as string, embedAllowedOrigins: [] },
        })
        const view = render(
          <DialogCopy event={eventType()} bookingPath="/ada/intro-call" onClose={() => {}} />,
        )
        try {
          expect(screen.queryByLabelText('Embed code')).toBeNull()
        } finally {
          view.unmount()
        }
      },
    )
  })
})
