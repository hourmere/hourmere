import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it } from 'vitest'
import '../../i18n/admin.ts'
import { RequestError, type requestError } from '../../api/errors.ts'
import { Field, FieldError, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { literal, msg } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { eventType } from '../../test/fixtures.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import * as formFunctions from './event-type-form.ts'
import * as notificationFunctions from './notifications-form.ts'
import type * as editorFunctions from './SuccessRedirectEditor.tsx'

const form = readFileSync('apps/web/src/pages/event-types/event-type-form.ts', 'utf8')
const editor = readFileSync('apps/web/src/pages/event-types/SuccessRedirectEditor.tsx', 'utf8')
const errors = readFileSync('apps/web/src/api/errors.ts', 'utf8')

function copy<T>(source: string, exported: string, dependencies: Record<string, unknown>): T {
  const compiled = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; import {transformSync} from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), {loader:'tsx',format:'cjs',jsxFactory:'react.createElement',jsxFragment:'react.Fragment'}).code)",
    ],
    {
      input: source.replace(/^import[\s\S]*?from '[^']+'$/gm, '').replace(/^export /gm, ''),
      encoding: 'utf8',
    },
  )
  return new Function(...Object.keys(dependencies), `${compiled}; return ${exported}`)(
    ...Object.values(dependencies),
  ) as T
}

function mutate(source: string, before: string, after: string) {
  expect(source.split(before), 'mutation anchor matches once').toHaveLength(2)
  return source.replace(before, after)
}

function detects(
  source: string,
  before: string,
  after: string,
  assertion: (source: string) => void,
) {
  const mutated = mutate(source, before, after)
  assertion(source)
  expect(() => assertion(mutated)).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  assertion(source)
}

const buildForm = (source: string) =>
  copy<typeof formFunctions>(
    source,
    '{draftFromEventType, toInput, toPatchInput, emptyDraft, serverErrors}',
    {
      ...notificationFunctions,
      RequestError,
      parseWhole,
      wholeNumberProblem,
      literal,
      msg,
      EVENT_TYPE,
      QUESTIONS,
      RULES,
      isMultiLineText,
      isSingleLineText,
      singleLineProblem,
    },
  )

const buildEditor = (source: string) =>
  copy<typeof editorFunctions>(source, '{SuccessRedirectEditor, previewSuccessRedirect}', {
    react,
    Field,
    FieldError,
    useI18n,
    SUCCESS_REDIRECT_PARAMETERS: formFunctions.SUCCESS_REDIRECT_PARAMETERS,
  })

function Harness({ Component }: { Component: typeof editorFunctions.SuccessRedirectEditor }) {
  const [draft, setDraft] = react.useState({
    ...formFunctions.emptyDraft(),
    successRedirectUrl: 'https://target.example/thanks',
  })
  return (
    <Component
      draft={draft}
      errors={{}}
      set={(name, value) => setDraft((current) => ({ ...current, [name]: value }))}
    />
  )
}

async function assertEditor(
  Component: typeof editorFunctions.SuccessRedirectEditor,
  check: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
) {
  const view = render(<Harness Component={Component} />)
  try {
    await check(userEvent.setup())
  } finally {
    view.unmount()
  }
}

describe('after-booking editor source-copy mutation controls', () => {
  it('detects re-sending untouched targets on unrelated edits', () => {
    detects(form, 'delete body.successRedirect', 'void 0', (source) => {
      const value = buildForm(source)
      const baseline = { ...value.emptyDraft(), successRedirectUrl: 'https://localhost/stale' }
      expect(value.toPatchInput({ ...baseline, title: 'Changed' }, baseline)).not.toHaveProperty(
        'successRedirect',
      )
    })
  })

  it('detects dropping an explicitly changed target from PATCH', () => {
    detects(
      form,
      'JSON.stringify(redirectInput(draft)) === JSON.stringify(redirectInput(baseline))',
      'true',
      (source) => {
        const value = buildForm(source)
        const baseline = value.emptyDraft()
        expect(
          value.toPatchInput(
            { ...baseline, successRedirectUrl: 'https://target.example' },
            baseline,
          ).successRedirect?.url,
        ).toBe('https://target.example')
      },
    )
  })

  it('detects trimming a destination before service validation', () => {
    detects(
      form,
      'url: draft.successRedirectUrl,',
      'url: draft.successRedirectUrl.trim(),',
      (source) => {
        const value = buildForm(source)
        const url = ' https://target.example '
        expect(
          value.toInput({ ...value.emptyDraft(), successRedirectUrl: url }).successRedirect?.url,
        ).toBe(url)
      },
    )
  })

  it('detects losing an explicit clear from PATCH', () => {
    detects(
      form,
      'else body.successRedirect = redirectInput(draft)',
      'else delete body.successRedirect',
      (source) => {
        const value = buildForm(source)
        const baseline = { ...value.emptyDraft(), successRedirectUrl: 'https://target.example/' }
        expect(
          value.toPatchInput({ ...baseline, successRedirectUrl: '' }, baseline).successRedirect,
        ).toBeNull()
      },
    )
  })

  it('detects sending untouched unset configuration on create', () => {
    detects(
      form,
      "draft.successRedirectUrl !== '' && { successRedirect: redirectInput(draft) }",
      'true && { successRedirect: redirectInput(draft) }',
      (source) => {
        const value = buildForm(source)
        expect(value.toInput(value.emptyDraft())).not.toHaveProperty('successRedirect')
      },
    )
  })

  it('detects losing the invitee personal-data opt-in on write', () => {
    detects(
      form,
      'includeInviteePersonalData: draft.includeInviteePersonalData,',
      'includeInviteePersonalData: false,',
      (source) => {
        const value = buildForm(source)
        expect(
          value.toInput({
            ...value.emptyDraft(),
            successRedirectUrl: 'https://target.example/',
            includeInviteePersonalData: true,
            successRedirectParameters: ['inviteeEmail'],
          }).successRedirect?.includeInviteePersonalData,
        ).toBe(true)
      },
    )
  })

  it('detects losing the saved opt-in flags on load', () => {
    detects(form, 'e.successRedirect?.allowEmbedParent ?? false', 'false', (source) => {
      expect(
        buildForm(source).draftFromEventType(
          eventType({
            successRedirect: {
              url: 'https://target.example',
              parameters: [],
              includeInviteePersonalData: true,
              allowEmbedParent: true,
            },
          }),
        ).allowEmbedParent,
      ).toBe(true)
    })
  })

  it('detects dropping inline stable-field error mapping', () => {
    detects(form, "err.field?.startsWith('successRedirect')", 'false', (source) => {
      const value = buildForm(source)
      const error = new RequestError(
        400,
        'invalid_success_redirect',
        'Server detail',
        undefined,
        undefined,
        undefined,
        undefined,
        'successRedirect.url',
      )
      expect(Object.keys(value.serverErrors(error, value.emptyDraft()).fields)).toEqual([
        'successRedirect.url',
      ])
    })
  })

  it('detects dropping the server field from the error response parser', () => {
    detects(
      errors,
      "typeof record.field === 'string' ? record.field : undefined",
      'undefined',
      (source) => {
        const value = copy<{ requestError: typeof requestError }>(source, '{requestError}', {
          literal,
          msg,
        })
        expect(
          value.requestError(400, {
            error: 'invalid_success_redirect',
            field: 'successRedirect.url',
          }).field,
        ).toBe('successRedirect.url')
      },
    )
  })

  it('detects unencoded URL sample values', () => {
    detects(
      editor,
      'const parameters = new URLSearchParams(',
      'const parameters = new UnsafeParameters(',
      (source) => {
        class UnsafeParameters {
          readonly values: [string, string][]
          constructor(values: [string, string][]) {
            this.values = values
          }
          get size() {
            return this.values.length
          }
          toString() {
            return this.values.map(([key, value]) => `${key}=${value}`).join('&')
          }
        }
        const value = copy<typeof editorFunctions>(source, '{previewSuccessRedirect}', {
          UnsafeParameters,
          SUCCESS_REDIRECT_PARAMETERS: formFunctions.SUCCESS_REDIRECT_PARAMETERS,
        })
        const preview =
          value.previewSuccessRedirect({
            ...formFunctions.emptyDraft(),
            successRedirectUrl: 'https://target.example/',
            successRedirectParameters: ['inviteeEmail'],
            includeInviteePersonalData: true,
          }) ?? ''
        expect(new URL(preview).searchParams.get('inviteeEmail')).toBe('sam+demo@example.com')
      },
    )
  })

  it('detects losing the saved target query text', () => {
    detects(
      editor,
      'const target = fragmentStart === -1 ? url : url.slice(0, fragmentStart)',
      "const target = 'https://target.example/'",
      (source) => {
        const value = buildEditor(source)
        const preview = value.previewSuccessRedirect({
          ...formFunctions.emptyDraft(),
          successRedirectUrl: 'https://target.example/?flag&a;b#done',
          successRedirectParameters: ['start'],
        })
        expect(preview).toContain('?flag&a;b&start=')
        expect(preview).toContain('#done')
      },
    )
  })

  it('detects personal data in the preview without explicit opt-in', () => {
    detects(
      editor,
      "draft.includeInviteePersonalData || (key !== 'inviteeName' && key !== 'inviteeEmail')",
      'true',
      (source) => {
        const value = buildEditor(source)
        const preview = value.previewSuccessRedirect({
          ...formFunctions.emptyDraft(),
          successRedirectUrl: 'https://target.example/',
          successRedirectParameters: ['inviteeEmail'],
        })
        expect(preview).not.toContain('inviteeEmail')
      },
    )
  })

  it('detects preview parameters returning to selection order', () => {
    const mutated = mutate(
      editor,
      'SUCCESS_REDIRECT_PARAMETERS.filter((key) => draft.successRedirectParameters.includes(key))',
      'draft.successRedirectParameters',
    )
    const original = buildEditor(editor)
    const mutant = buildEditor(mutated)
    const assertPreview = (value: typeof editorFunctions) => {
      const preview = value.previewSuccessRedirect({
        ...formFunctions.emptyDraft(),
        successRedirectUrl: 'https://target.example/?flag&a;b#done',
        successRedirectParameters: ['end', 'start'],
      })
      expect(preview).toBe(
        'https://target.example/?flag&a;b&start=2030-01-15T10%3A00%3A00Z&end=2030-01-15T10%3A30%3A00Z#done',
      )
    }
    assertPreview(original)
    expect(() => assertPreview(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertPreview(buildEditor(editor))
  })

  it.each([
    {
      before: 'aria-live="off"',
      after: '',
      check: async () => {
        expect(screen.getByLabelText('Example continuation URL').getAttribute('aria-live')).toBe(
          'off',
        )
      },
    },
    {
      before: 'htmlFor="successRedirect.url"',
      after: '',
      check: async () => {
        expect(screen.getByLabelText('Example continuation URL').getAttribute('for')).toBe(
          screen.getByLabelText(/Continue to URL/).id,
        )
      },
    },
  ])('detects lost preview accessibility: $before', async ({ before, after, check }) => {
    const original = buildEditor(editor).SuccessRedirectEditor
    const mutant = buildEditor(mutate(editor, before, after)).SuccessRedirectEditor
    await assertEditor(original, check)
    await expect(assertEditor(mutant, check)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertEditor(buildEditor(editor).SuccessRedirectEditor, check)
  })

  it.each([
    {
      before: '<p id="success-redirect-personal-warning" className="hint">',
      after:
        '<p id="success-redirect-personal-warning" className="hint" hidden={!draft.includeInviteePersonalData}>',
      check: async () => {
        const warning = screen.getByText(/Warning: sharing invitee name or email/)
        expect(warning.hidden).toBe(false)
        expect(
          screen.getByLabelText<HTMLInputElement>('Allow sharing invitee name and email').checked,
        ).toBe(false)
      },
    },
    {
      before: 'disabled={!draft.includeInviteePersonalData}',
      after: 'disabled={false}',
      check: async () => {
        expect(screen.getByLabelText<HTMLInputElement>('Invitee name').disabled).toBe(true)
        expect(screen.getByLabelText<HTMLInputElement>('Invitee email').disabled).toBe(true)
      },
    },
    {
      before: "parameter !== 'inviteeName' && parameter !== 'inviteeEmail'",
      after: 'true',
      check: async (user: ReturnType<typeof userEvent.setup>) => {
        const optIn = screen.getByLabelText('Allow sharing invitee name and email')
        await user.click(optIn)
        await user.click(screen.getByLabelText('Invitee email'))
        await user.click(optIn)
        expect(screen.getByLabelText<HTMLInputElement>('Invitee email').checked).toBe(false)
      },
    },
  ])('detects weakened personal-data protection: $before', async ({ before, after, check }) => {
    const original = buildEditor(editor).SuccessRedirectEditor
    const mutant = buildEditor(mutate(editor, before, after)).SuccessRedirectEditor
    await assertEditor(original, check)
    await expect(assertEditor(mutant, check)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertEditor(buildEditor(editor).SuccessRedirectEditor, check)
  })
})
