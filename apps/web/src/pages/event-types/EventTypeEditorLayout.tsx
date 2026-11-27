import type { EventPayment } from '@hourmere/core/payment'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { loadBrandLogo, type Profile } from '../../api/resources.ts'
import { parseWhole } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { RULES } from '../../limits.ts'
import { BookingPagePreview } from '../../public/BookingPagePreview.tsx'
import type { Me } from '../../session.tsx'
import { draftQuestions, type EventTypeDraft, orderedLocations } from './event-type-form.ts'
import './event-type-editor-layout.css'

const WIDE_EDITOR = '(min-width: 1280px)'

/** Saved assets load through the admin API once per space. The booking preview receives bytes. */
function useSavedBranding(organization: Me['organization'], canRead: boolean) {
  const { id, name } = organization
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!canRead) return null
      const brand = await unwrap(
        api.GET('/api/v1/branding', { headers: { 'X-Expected-Organization-Id': id }, signal }),
      )
      const logoSrc = brand.brandLogo
        ? await loadBrandLogo(id, brand.brandLogo, signal).catch(() => undefined)
        : undefined
      return {
        id,
        logoSrc,
        branding: { name, primaryColor: brand.brandPrimaryColor, logoUrl: null, logoDataUrl: null },
      }
    },
    [canRead, id, name],
  )
  const [state] = useLoad(load)
  return canRead && state.status === 'ready' && state.data?.id === id ? state.data : undefined
}

function previewEvent(
  draft: EventTypeDraft,
  me: Me,
  profile: Profile | null,
  smsRemindersAvailable: boolean | undefined,
  branding: Schemas['PublicEventType']['branding'],
  payment: EventPayment | null,
): Schemas['PublicEventType'] {
  const duration = parseWhole(draft.durationMinutes)
  const { min, max } = RULES.durationMinutes
  const durationMinutes =
    duration !== null && duration >= min && duration <= max
      ? duration
      : (draft.allowedDurationsMinutes[0] ?? 30)
  const locations = orderedLocations(draft).map((option) => ({
    id: option.id,
    kind: option.kind,
    ...(option.label?.trim() && { label: option.label.trim() }),
    ...(option.isDefault && { isDefault: option.isDefault }),
    ...(option.kind === 'phone' && option.askInvitee && { askInvitee: true as const }),
  }))
  const roundRobin = draft.schedulingType === 'round_robin'
  const timeZone =
    !roundRobin &&
    (me.organization.personal ||
      (draft.hostUserIds.length === 1 && draft.hostUserIds[0] === me.user.id))
      ? profile?.timeZone
      : undefined

  return {
    handle: profile?.handle ?? '',
    slug: draft.slug,
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    durationMinutes,
    ...(draft.allowedDurationsMinutes.length > 1 && {
      allowedDurationsMinutes: [...draft.allowedDurationsMinutes].sort((a, b) => a - b),
    }),
    location: draft.locationKind ? { kind: draft.locationKind } : null,
    locations:
      locations.length && (draft.locationOptions !== null || locations[0]?.askInvitee)
        ? locations
        : null,
    questions: draftQuestions(draft.questions)
      .filter((question) => question.label !== '')
      .map((question) =>
        question.options
          ? { ...question, options: [...new Set(question.options.filter(Boolean))] }
          : question,
      ),
    allowGuests: draft.allowGuests,
    smsRemindersEnabled: smsRemindersAvailable === true && draft.smsRemindersEnabled,
    host: { name: me.user.name, ...(timeZone !== undefined && { timeZone }) },
    ...(roundRobin && { schedulingType: 'round_robin' as const }),
    ...(!me.organization.personal && {
      team: { name: me.organization.name, slug: me.organization.slug },
    }),
    ...(branding && { branding }),
    ...(payment && { payment }),
  }
}

export function EventTypeEditorLayout({
  children,
  draft,
  me,
  profile,
  smsRemindersAvailable,
  canReadBranding,
  payment,
}: {
  children: ReactNode
  draft: EventTypeDraft
  me: Me
  profile: Profile | null
  smsRemindersAvailable: boolean | undefined
  canReadBranding: boolean
  payment: EventPayment | null
}) {
  const { t } = useI18n()
  const title = t('Booking page preview')
  const headingId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE_EDITOR).matches ?? false)
  const [open, setOpen] = useState(false)
  const brand = useSavedBranding(me.organization, canReadBranding)

  useEffect(() => {
    const media = window.matchMedia?.(WIDE_EDITOR)
    if (!media) return
    const resize = () => {
      setWide(media.matches)
      if (media.matches) setOpen(false)
    }
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])

  const preview = (wide || open) && (
    <BookingPagePreview
      event={previewEvent(draft, me, profile, smsRemindersAvailable, brand?.branding, payment)}
      {...(brand?.logoSrc && { logoSrc: brand.logoSrc })}
    />
  )

  return (
    <div className="event-type-editor-layout">
      {!wide && (
        <div className="event-type-preview-action">
          <button
            ref={trigger}
            type="button"
            className="button"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            {t('Preview booking page')}
          </button>
        </div>
      )}
      <div className="event-type-editor-settings">{children}</div>
      {wide ? (
        <aside className="event-type-preview-pane" aria-labelledby={headingId}>
          <header className="event-type-preview-header">
            <h2 id={headingId}>{title}</h2>
          </header>
          {preview}
        </aside>
      ) : (
        open && (
          <PreviewDialog
            headingId={headingId}
            title={title}
            closeLabel={t('Close')}
            onClose={() => {
              setOpen(false)
              trigger.current?.focus()
            }}
          >
            {preview}
          </PreviewDialog>
        )
      )}
    </div>
  )
}

function PreviewDialog({
  children,
  headingId,
  title,
  closeLabel,
  onClose,
}: {
  children: ReactNode
  headingId: string
  title: string
  closeLabel: string
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element || element.open) return
    element.showModal()
    closeButton.current?.focus()
  }, [])

  function close() {
    dialog.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="event-type-preview-dialog"
      aria-labelledby={headingId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header className="event-type-preview-header">
        <h2 id={headingId}>{title}</h2>
        <button ref={closeButton} type="button" className="button" onClick={close}>
          {closeLabel}
        </button>
      </header>
      {children}
    </dialog>
  )
}
