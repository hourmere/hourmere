import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import { emptyDraft } from './event-type-form.ts'

const source = readFileSync('apps/web/src/pages/event-types/EventTypeEditor.tsx', 'utf8')
function compile<T>(code: string, name: string, dependencies: Record<string, unknown> = {}): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement' }).code)",
    ],
    { input: code, encoding: 'utf8' },
  )
  return new Function('reactRuntime', ...Object.keys(dependencies), `${compiled}; return ${name}`)(
    react,
    ...Object.values(dependencies),
  ) as T
}
function detects(code: string, before: string, after: string, verify: (copy: string) => void) {
  expect(code.split(before)).toHaveLength(2)
  verify(code)
  expect(() => verify(code.replace(before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  verify(code)
}

describe('essentials production-source negative controls', () => {
  const group = source.slice(source.indexOf('function SettingsGroup('))
  it.each([
    ['useState(initiallyOpen)', 'useState(true)'],
    ['useState(initiallyOpen)', 'useState(false)'],
    ['<summary>{t(label)}</summary>', '<div>{t(label)}</div>'],
    ['{children}</div>', '{open && children}</div>'],
  ])('detects loss of disclosure state, semantics or retained fields: %s → %s', (before, after) => {
    detects(group, before, after, (copy) => {
      const Group = compile<
        react.ComponentType<{ label: string; initiallyOpen: boolean; children: react.ReactNode }>
      >(copy, 'SettingsGroup', {
        useState: react.useState,
        useI18n: () => ({ t: (text: string) => text }),
      })
      for (const initiallyOpen of [false, true]) {
        const view = render(
          <Group label="Settings" initiallyOpen={initiallyOpen}>
            <input defaultValue="Preserved" />
          </Group>,
        )
        try {
          expect(view.container.querySelector('details')?.open).toBe(initiallyOpen)
          expect(view.container.querySelector('details > summary')?.textContent).toBe('Settings')
          expect(view.container.querySelector('input')?.value).toBe('Preserved')
        } finally {
          view.unmount()
        }
      }
    })
  })

  const effectStart = source.indexOf('  useEffect(() => {', source.indexOf('const formRef'))
  const effect = source.slice(effectStart, source.indexOf('  const mounted', effectStart))
  it.each([
    ['group.open = true', 'group.open = false'],
    ['hiddenField?.focus()', 'void hiddenField'],
  ])('detects loss of hidden validation recovery: %s', (before, after) => {
    detects(effect, before, after, (copy) => {
      const view = render(
        <form>
          <details>
            <summary>Timing</summary>
            <input id="mutation-buffer" />
          </details>
        </form>,
      )
      try {
        compile<() => void>(`function reveal() { ${copy} }`, 'reveal', {
          useEffect: (run: () => void) => run(),
          attempt: 1,
          errors: { 'mutation-buffer': 'Invalid' },
          formRef: { current: view.container.querySelector('form') },
        })()
        expect(view.container.querySelector('details')?.open).toBe(true)
        expect(document.activeElement).toBe(view.container.querySelector('input'))
      } finally {
        view.unmount()
      }
    })
  })

  it('detects silently hiding nondefault settings on edit', () => {
    const start = source.indexOf('  const changed = (...fields:')
    const changed = source.slice(start, source.indexOf('  const duration', start))
    detects(changed, 'editing &&', 'false &&', (copy) => {
      const defaults = emptyDraft()
      const check = compile<(...fields: string[]) => boolean>(copy, 'changed', {
        editing: true,
        defaults,
        baseline: { ...defaults, description: 'Saved', bufferBeforeMinutes: '10', isHidden: true },
      })
      expect(check('description')).toBe(true)
      expect(check('bufferBeforeMinutes')).toBe(true)
      expect(check('isHidden')).toBe(true)
      expect(check('position')).toBe(false)
    })
  })

  it('detects leaving an error-summary destination hidden after manual collapse', () => {
    const start = source.indexOf('          const link = (event.target as HTMLElement)')
    const handler = source.slice(start, source.indexOf('        }}', start))
    detects(handler, 'if (group) group.open = true', 'if (group) group.open = false', (copy) => {
      const view = render(
        <form>
          <a href="#summary-destination">Fix timing</a>
          <details>
            <summary>Timing</summary>
            <input id="summary-destination" />
          </details>
        </form>,
      )
      try {
        compile<() => void>(`function activate() { ${copy} }`, 'activate', {
          event: { target: view.container.querySelector('a') },
        })()
        expect(view.container.querySelector('details')?.open).toBe(true)
      } finally {
        view.unmount()
      }
    })
  })
})
