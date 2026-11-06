import { type FormEvent, useCallback, useRef, useState } from 'react'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { Field } from '../components/forms.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

export function BrandSettings({
  organizationId,
  canManage,
}: {
  organizationId: string
  canManage: boolean | null
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <section className="panel" aria-labelledby="branding-heading">
      <h2 id="branding-heading">{t('Booking page branding')}</h2>
      <p>
        {t(
          'Save a logo and primary colour for this space. Applying them to booking pages and emails is not available yet.',
        )}
      </p>
      {canManage === null ? (
        <p role="status">{t('Branding access has not been confirmed.')}</p>
      ) : !canManage ? (
        <p>{t('Only the personal owner or team owners and admins can manage branding.')}</p>
      ) : (
        <>
          <button
            type="button"
            className="button"
            aria-expanded={open}
            aria-controls="branding-editor"
            onClick={() => setOpen(true)}
            disabled={open}
          >
            {t('Manage branding')}
          </button>
          {open && (
            <div id="branding-editor">
              <BrandLoader organizationId={organizationId} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function BrandLoader({ organizationId }: { organizationId: string }) {
  const { t, ui } = useI18n()
  const load = useCallback(
    (signal: AbortSignal) =>
      unwrap(
        api.GET('/api/v1/branding', {
          headers: { 'X-Expected-Organization-Id': organizationId },
          signal,
        }),
      ),
    [organizationId],
  )
  const [state, reload] = useLoad(load)
  if (state.status === 'loading') return <p role="status">{t('Loading branding…')}</p>
  if (state.status === 'error')
    return (
      <div role="alert">
        <p>
          {t('Could not load branding.')} {ui(state.message)}
        </p>
        <button type="button" className="button" onClick={reload}>
          {t('Try again')}
        </button>
      </div>
    )
  return <BrandForm organizationId={organizationId} initial={state.data} />
}

type Brand = {
  brandLogo: string | null
  brandPrimaryColor: string | null
  buttonTextColor: string | null
  backgroundContrast: number | null
}

function BrandForm({ organizationId, initial }: { organizationId: string; initial: Brand }) {
  const { t, ui } = useI18n()
  const mounted = useMounted()
  const [saved, setSaved] = useState(initial)
  const [colour, setColour] = useState(initial.brandPrimaryColor ?? '')
  const [logo, setLogo] = useState(initial.brandLogo)
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [message, setMessage] = useState<UiText>('')
  const [success, setSuccess] = useState(false)
  const dirty =
    colour !== (saved.brandPrimaryColor ?? '') || logo !== saved.brandLogo || file !== null
  useUnsavedChanges(dirty)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || stale) return
    setSuccess(false)
    setMessage('')
    if (colour && !/^#[0-9a-f]{6}$/i.test(colour)) {
      setMessage('Enter a colour in #RRGGBB format, or leave it empty to clear it.')
      return
    }
    if (
      file &&
      (file.size === 0 ||
        file.size > 512 * 1024 ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    ) {
      setMessage('Choose a PNG, JPEG or WebP image up to 512 KB. SVG is not supported.')
      return
    }
    setBusy(true)
    try {
      let next = saved
      const patch: { brandPrimaryColor?: string | null; brandLogo?: string | null } = {}
      if (colour !== (saved.brandPrimaryColor ?? '')) patch.brandPrimaryColor = colour || null
      if (!file && logo !== saved.brandLogo) patch.brandLogo = logo
      if (file) {
        const result = await unwrap(
          api.POST('/api/v1/branding/logo', {
            headers: { 'X-Expected-Organization-Id': organizationId, 'Content-Type': file.type },
            // OpenAPI represents binary bodies as strings; serialize the selected file unchanged.
            body: '',
            bodySerializer: () => file,
          }),
        )
        next = result
        if (!mounted.current) return
        setSaved((previous) => ({ ...previous, brandLogo: result.brandLogo }))
        setLogo(result.brandLogo)
        setFile(null)
        if (fileInput.current) fileInput.current.value = ''
      }
      if (!mounted.current) return
      const result = Object.keys(patch).length
        ? await unwrap(
            api.PATCH('/api/v1/branding', {
              headers: { 'X-Expected-Organization-Id': organizationId },
              body: patch,
            }),
          )
        : next
      if (!mounted.current) return
      setSaved(result)
      setColour(result.brandPrimaryColor ?? '')
      setLogo(result.brandLogo)
      setFile(null)
      setSuccess(true)
    } catch (error) {
      if (!mounted.current) return
      if (isOrganizationContextChanged(error)) setStale(true)
      setMessage(
        error instanceof RequestError &&
          ['invalid_brand_logo', 'brand_logo_too_large', 'payload_too_large'].includes(
            error.code ?? '',
          )
          ? 'Choose a valid PNG, JPEG or WebP image up to 512 KB and 2048 × 2048 pixels. SVG and animated images are not supported.'
          : error instanceof RequestError && error.code === 'invalid_brand_color'
            ? 'Enter a colour in #RRGGBB format, or leave it empty to clear it.'
            : errorMessage(error),
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <form className="stack" aria-label={t('Edit branding')} onSubmit={submit} noValidate>
      {message && (
        <p className="alert alert-error" role="alert">
          {ui(message)}
        </p>
      )}
      <fieldset className="form-fieldset stack" disabled={busy || stale}>
        <Field
          id="brand-colour"
          label={t('Primary colour')}
          hint={t('Enter a colour in #RRGGBB format, or leave it empty to clear it.')}
        >
          {(props) => (
            <input
              {...props}
              value={colour}
              maxLength={7}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setColour(event.target.value)
                setSuccess(false)
              }}
            />
          )}
        </Field>
        <p className="hint">
          {t(
            'Black or white button text is selected automatically for at least 4.5:1 contrast. Contrast against the white page background is reported separately.',
          )}
        </p>
        <Field
          id="brand-logo"
          label={t('Brand logo')}
          hint={t(
            'Choose a valid PNG, JPEG or WebP image up to 512 KB and 2048 × 2048 pixels. SVG and animated images are not supported.',
          )}
        >
          {(props) => (
            <input
              {...props}
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null)
                setSuccess(false)
              }}
            />
          )}
        </Field>
        {logo && (
          <>
            <p>{t('A logo is saved for this space.')}</p>
            <BrandLogoPreview key={logo} organizationId={organizationId} hash={logo} />
          </>
        )}
        {(logo || file) && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setLogo(null)
              setFile(null)
              if (fileInput.current) fileInput.current.value = ''
              setSuccess(false)
            }}
          >
            {t('Remove logo')}
          </button>
        )}
        <button type="submit" className="button button-primary" disabled={!dirty}>
          {busy ? t('Saving…') : t('Save branding')}
        </button>
      </fieldset>
      {saved.brandPrimaryColor && (
        <p>
          {t('Saved colour: {colour}. Button text: {text}. Contrast against white: {ratio}:1.', {
            colour: saved.brandPrimaryColor,
            text: saved.buttonTextColor === '#000000' ? t('Black') : t('White'),
            ratio: saved.backgroundContrast?.toFixed(2) ?? '—',
          })}
        </p>
      )}
      <p role="status">
        {success
          ? t('Branding saved. Booking pages and emails are unchanged.')
          : dirty
            ? t('Unsaved changes')
            : ''}
      </p>
    </form>
  )
}

function BrandLogoPreview({ organizationId, hash }: { organizationId: string; hash: string }) {
  const { t } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal) => {
      const bytes = await unwrap(
        api.GET('/api/v1/branding/logo/{hash}', {
          params: { path: { hash } },
          headers: { 'X-Expected-Organization-Id': organizationId },
          signal,
          parseAs: 'arrayBuffer',
        }),
      )
      return `data:image/png;base64,${btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(''))}`
    },
    [organizationId, hash],
  )
  const [preview] = useLoad(load)
  if (preview.status === 'loading') return <p role="status">{t('Loading logo preview…')}</p>
  if (preview.status === 'error') return <p role="status">{t('Logo preview is unavailable.')}</p>
  return (
    <img
      src={preview.data}
      alt={t('Saved brand logo')}
      width={160}
      height={160}
      style={{ objectFit: 'contain' }}
    />
  )
}
