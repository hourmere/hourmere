import { brandColorContrast, brandPalette } from '@hourmere/core/brand-contrast'
import { type FormEvent, useCallback, useRef, useState } from 'react'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { loadBrandLogo } from '../api/resources.ts'
import { Field } from '../components/forms.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

type BrandAccess = { read: boolean; update: boolean; upload: boolean }
const manageBranding: BrandAccess = { read: true, update: true, upload: true }

export function BrandSettings({
  organizationId,
  canManage,
  permissionView,
}: {
  organizationId: string
  canManage: boolean | null
  permissionView?: BrandAccess
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const access = permissionView ?? (canManage ? manageBranding : undefined)
  const editable = access?.update || access?.upload
  return (
    <section className="panel" aria-labelledby="branding-heading">
      <h2 id="branding-heading">{t('Booking page branding')}</h2>
      <p>
        {t('Use this space’s logo and primary colour on booking pages, embeds and booking emails.')}
      </p>
      {!permissionView && canManage === null ? (
        <p role="status">{t('Branding access has not been confirmed.')}</p>
      ) : !access?.read ? (
        <p>
          {t(
            permissionView
              ? 'Your current team permissions do not include viewing branding.'
              : 'Only the personal owner or team owners and admins can manage branding.',
          )}
        </p>
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
            {t(editable ? 'Manage branding' : 'View team branding')}
          </button>
          {open && (
            <div id="branding-editor">
              <BrandLoader organizationId={organizationId} access={access} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function BrandLoader({ organizationId, access }: { organizationId: string; access: BrandAccess }) {
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
  if (!access.update && !access.upload)
    return (
      <BrandPreviews
        organizationId={organizationId}
        hash={state.data.brandLogo}
        colour={state.data.brandPrimaryColor ?? ''}
        file={null}
        editable={false}
      />
    )
  return <BrandForm organizationId={organizationId} initial={state.data} access={access} />
}

type Brand = {
  brandLogo: string | null
  brandPrimaryColor: string | null
  buttonTextColor: string | null
  backgroundContrast: number | null
}

function BrandForm({
  organizationId,
  initial,
  access,
}: {
  organizationId: string
  initial: Brand
  access: BrandAccess
}) {
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
      setMessage('Choose a PNG, JPEG or WebP image up to 512 KiB. SVG is not supported.')
      return
    }
    setBusy(true)
    try {
      let next = saved
      const patch: { brandPrimaryColor?: string | null; brandLogo?: string | null } = {}
      if (access.update && colour !== (saved.brandPrimaryColor ?? ''))
        patch.brandPrimaryColor = colour || null
      if (access.update && !file && logo !== saved.brandLogo) patch.brandLogo = logo
      if (access.upload && file) {
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
          ? 'Choose a valid PNG, JPEG or WebP image up to 512 KiB and 2048 × 2048 pixels. SVG and animated images are not supported.'
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
        {access.update && (
          <>
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
                'Black or white button text is selected automatically for at least 4.5:1 contrast. Contrast against white (#FFFFFF) is reported separately.',
              )}
            </p>
          </>
        )}
        {access.upload && (
          <>
            <Field
              id="brand-logo"
              label={t('Brand logo')}
              hint={t(
                'Choose a valid PNG, JPEG or WebP image up to 512 KiB and 2048 × 2048 pixels. SVG and animated images are not supported.',
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
            <p className="hint">
              {t(
                'Logos are converted to PNG, at most 512 pixels on the longest side and 64 KiB. Smaller images are not enlarged.',
              )}
            </p>
          </>
        )}
        {logo && <p>{t('A logo is saved for this space.')}</p>}
        {((access.update && logo) || file) && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setLogo(access.update ? null : saved.brandLogo)
              setFile(null)
              if (fileInput.current) fileInput.current.value = ''
              setSuccess(false)
            }}
          >
            {t(access.update ? 'Remove logo' : 'Cancel')}
          </button>
        )}
        {access.update && (
          <>
            <button
              type="button"
              className="button"
              disabled={!colour && !logo && !file}
              onClick={() => {
                setColour('')
                setLogo(null)
                setFile(null)
                if (fileInput.current) fileInput.current.value = ''
                setSuccess(false)
              }}
            >
              {t('Reset to default')}
            </button>
            <p className="hint">{t('Reset clears the logo and colour when you save branding.')}</p>
          </>
        )}
        <button type="submit" className="button button-primary" disabled={!dirty}>
          {busy ? t('Saving…') : t('Save branding')}
        </button>
      </fieldset>
      <BrandPreviews organizationId={organizationId} hash={logo} file={file} colour={colour} />
      {saved.brandPrimaryColor && (
        <p>
          {t('Saved colour: {colour}. Button text: {text}. Contrast against white: {ratio}:1.', {
            colour: saved.brandPrimaryColor,
            text: saved.buttonTextColor === '#000000' ? t('Black') : t('White'),
            ratio: saved.backgroundContrast?.toFixed(2) ?? '—',
          })}
        </p>
      )}
      <p role="status">{success ? t('Branding saved.') : dirty ? t('Unsaved changes') : ''}</p>
    </form>
  )
}

function BrandPreviews({
  organizationId,
  hash,
  file,
  colour,
  editable = true,
}: {
  organizationId: string
  hash: string | null
  file: File | null
  colour: string
  editable?: boolean
}) {
  const { t } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (file) {
        if (
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
          file.size === 0 ||
          file.size > 512 * 1024
        )
          return null
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('Logo preview unavailable'))
          reader.readAsDataURL(file)
        })
      }
      return hash ? loadBrandLogo(organizationId, hash, signal) : null
    },
    [organizationId, hash, file],
  )
  const [preview] = useLoad(load)
  const palette = brandPalette(colour)
  // Match the public theme's default accent when branding is cleared or invalid.
  const defaults = {
    light: { accent: '#1F4FD8', accentText: '#FFFFFF', link: '#1F4FD8' },
    dark: { accent: '#3D68E6', accentText: '#FFFFFF', link: '#8FAEFF' },
  }
  const src = preview.status === 'ready' ? preview.data : null
  return (
    <section className="stack" aria-label={t('Booking page preview')}>
      <h3>{t('Booking page preview')}</h3>
      {editable && (
        <p className="hint">
          {t(
            'Sample only. Changes apply after saving. Colours adjust in each theme for readable text and controls.',
          )}
        </p>
      )}
      {preview.status === 'loading' && (hash || file) && (
        <p role="status">{t('Loading logo preview…')}</p>
      )}
      {preview.status === 'error' && <p role="status">{t('Logo preview is unavailable.')}</p>}
      {src && !file && (
        <img
          src={src}
          alt={t('Saved brand logo')}
          width={160}
          height={80}
          style={{ objectFit: 'contain' }}
        />
      )}
      {colour && !palette && (
        <p role="status">{t('Enter a colour in #RRGGBB format, or leave it empty to clear it.')}</p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
          gap: '1rem',
        }}
      >
        {(['light', 'dark'] as const).map((mode) => {
          const theme = (palette ?? defaults)[mode]
          const background = mode === 'light' ? '#FFFFFF' : '#0E1015'
          return (
            <section
              key={mode}
              aria-label={t(mode === 'light' ? 'Light preview' : 'Dark preview')}
              data-brand-preview={mode}
              style={{
                background,
                color: mode === 'light' ? '#172033' : '#F1F4FC',
                border: '1px solid #738099',
                borderRadius: '12px',
                padding: '1rem',
                minWidth: 0,
              }}
            >
              <h4>{t(mode === 'light' ? 'Light preview' : 'Dark preview')}</h4>
              {src && (
                <img
                  src={src}
                  alt=""
                  width={160}
                  height={64}
                  style={{ maxWidth: '100%', objectFit: 'contain' }}
                />
              )}
              <p>
                <strong>{t('Sample introduction call')}</strong>
              </p>
              <p>{t('30 minutes · Online meeting')}</p>
              <p style={{ color: theme.link }}>{t('Choose a time that works for you.')}</p>
              <span
                style={{
                  display: 'inline-block',
                  padding: '0.65rem 1rem',
                  borderRadius: '8px',
                  background: theme.accent,
                  color: theme.accentText,
                }}
              >
                {t('Confirm booking')}
              </span>
              <p>
                {t('Button text contrast: {ratio}:1 (minimum 4.5:1).', {
                  ratio: brandColorContrast(theme.accent, theme.accentText).toFixed(2),
                })}
              </p>
              <p>
                {t('Link contrast: {ratio}:1 (minimum 4.5:1).', {
                  ratio: brandColorContrast(theme.link, background).toFixed(2),
                })}
              </p>
              <p>{t('Displayed accent: {colour}', { colour: theme.accent })}</p>
              <small>{t('Powered by {0}', { '0': 'Hourmere' })}</small>
            </section>
          )
        })}
      </div>
    </section>
  )
}
