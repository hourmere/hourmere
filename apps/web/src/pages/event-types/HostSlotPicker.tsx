import { type InterfaceLanguage, registeredLocales } from '@hourmere/core/language'
import {
  formatSlotLabel,
  formatSlotSnippet,
  resolveSnippetLocale,
  resolveSnippetTimeZone,
} from '@hourmere/core/slot-snippet'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { EventType, Profile } from '../../api/resources.ts'
import { timeZoneNames } from '../../components/TimeZonePicker.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { codeOf, eventSlots, getEventType, type Slot } from '../../public/api.ts'

export interface HostSlotPickerProps {
  event: EventType
  profile: Profile | null
  address:
    | { kind: 'personal'; handle: string; slug: string }
    | { kind: 'team'; teamSlug: string; slug: string }
  publicUrl: string
  /** Recheck the saved event's owner, current organization and current manager role. */
  verifyAccess: () => Promise<void>
  disabled?: boolean
}

/** The saved identity is also the cancellation boundary for every transient selection. */
export function HostSlotPicker(props: HostSlotPickerProps) {
  const identity = JSON.stringify([
    props.event.id,
    props.event.updatedAt,
    props.event.durationMinutes,
    props.event.allowedDurationsMinutes,
    props.event.title,
    props.address,
    props.publicUrl,
  ])
  return <Picker key={identity} {...props} />
}

const sorted = (slots: Slot[]) => [...slots].sort((a, b) => a.start.localeCompare(b.start))
const exact = (a: Slot, b: Slot) =>
  Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end)

function Picker({
  event,
  profile,
  address,
  publicUrl,
  verifyAccess,
  disabled = false,
}: HostSlotPickerProps) {
  const { t } = useI18n()
  const id = useId()
  const [durationMinutes, setDuration] = useState(event.durationMinutes)
  const [locale, setLocale] = useState(() => resolveSnippetLocale(profile?.locale))
  const [displayTimeZone, setZone] = useState(() => resolveSnippetTimeZone(profile?.timeZone))
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [reload, setReload] = useState(0)
  const [offered, setOffered] = useState<Slot[]>([])
  const [selected, setSelected] = useState<Slot[]>([])
  const [stale, setStale] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewVisible, setPreviewVisible] = useState(false)
  const [previewSource, setPreviewSource] = useState({ title: event.title, address })
  const [manual, setManual] = useState(false)
  const [status, setStatus] = useState<MessageKey | null>(null)
  const version = useRef(0)
  const copying = useRef<AbortController | null>(null)
  const blocked = useRef(disabled)
  blocked.current = disabled
  const preview = useRef<HTMLTextAreaElement>(null)
  const handle = address.kind === 'team' ? address.teamSlug : address.handle
  const team = address.kind === 'team'
  const slug = address.slug
  const zones = useMemo(
    () => [...new Set(['UTC', displayTimeZone, ...timeZoneNames()])].sort(),
    [displayTimeZone],
  )
  const label = (slot: Slot) => formatSlotLabel(slot.start, slot.end, locale, displayTimeZone)
  const formatted = useMemo(() => {
    if (!previewVisible || !selected.length || stale.length) return null
    try {
      return formatSlotSnippet({
        publicUrl,
        address: previewSource.address,
        title: previewSource.title,
        durationMinutes,
        starts: selected.map((slot) => slot.start),
        locale,
        displayTimeZone,
      })
    } catch {
      return null
    }
  }, [
    previewVisible,
    selected,
    stale,
    publicUrl,
    previewSource,
    durationMinutes,
    locale,
    displayTimeZone,
  ])

  useEffect(
    () => () => {
      version.current += 1
      copying.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (disabled) {
      version.current += 1
      copying.current?.abort()
      setPreviewVisible(false)
      setManual(false)
      setBusy(false)
    }
  }, [disabled])

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry refreshes the same day.
  useEffect(() => {
    if (disabled) return
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    setOffered([])
    async function load() {
      try {
        const start = Date.parse(`${date}T00:00:00.000Z`)
        const boundary = start + 24 * 60 * 60_000
        // Include cross-midnight meetings while keeping work bounded to a single start day.
        const load = eventSlots(handle, slug, team, durationMinutes)
        const end = boundary + durationMinutes * 60_000
        let slots: Slot[]
        try {
          slots = await load(
            new Date(start).toISOString(),
            new Date(end).toISOString(),
            controller.signal,
          )
        } catch (error) {
          if (codeOf(error) !== 'range_too_long' || controller.signal.aborted) throw error
          // Two bounded start windows also fit the candidate budget for eight hosts,
          // a one-minute step and a 24-hour meeting. Never scan a larger horizon.
          const middle = start + 12 * 60 * 60_000
          const halves = await Promise.all([
            load(
              new Date(start).toISOString(),
              new Date(middle + durationMinutes * 60_000).toISOString(),
              controller.signal,
            ),
            load(new Date(middle).toISOString(), new Date(end).toISOString(), controller.signal),
          ])
          slots = [
            ...halves[0].filter((slot) => Date.parse(slot.start) < middle),
            ...halves[1].filter((slot) => Date.parse(slot.start) >= middle),
          ]
        }
        if (controller.signal.aborted) return
        setOffered(
          sorted(
            slots.filter(
              (slot) =>
                Date.parse(slot.start) >= start &&
                Date.parse(slot.start) < boundary &&
                Date.parse(slot.end) === Date.parse(slot.start) + durationMinutes * 60_000,
            ),
          ),
        )
      } catch {
        if (!controller.signal.aborted) setLoadError(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [date, durationMinutes, reload, handle, slug, team, disabled])

  function invalidate() {
    version.current += 1
    copying.current?.abort()
    setPreviewVisible(false)
    setManual(false)
    setStatus(null)
  }
  function choose(slot: Slot) {
    invalidate()
    setSelected((current) => {
      if (current.some((item) => exact(item, slot)))
        return current.filter((item) => !exact(item, slot))
      if (current.length >= 10) return current
      return sorted([...current, slot])
    })
    setStale((current) => current.filter((start) => start !== slot.start))
  }
  function remove(slot: Slot) {
    invalidate()
    setSelected((current) => current.filter((item) => !exact(item, slot)))
    setStale((current) => current.filter((start) => start !== slot.start))
  }
  async function showPreview() {
    if (disabled || busy || !selected.length || stale.length) return
    const controller = new AbortController()
    copying.current?.abort()
    copying.current = controller
    const requestVersion = ++version.current
    const current = () =>
      !controller.signal.aborted && version.current === requestVersion && !blocked.current
    setBusy(true)
    setPreviewVisible(false)
    setManual(false)
    setStatus('Checking preview access…')
    try {
      await verifyAccess()
      if (!current()) return
      setPreviewSource({ title: event.title, address })
      setPreviewVisible(true)
      setStatus(null)
    } catch {
      if (current())
        setStatus('We could not prepare the preview. Nothing was copied. Please try again.')
    } finally {
      if (current()) setBusy(false)
    }
  }

  async function copy(kind: 'plain' | 'rich') {
    if (busy || disabled || !selected.length || selected.length > 10 || stale.length) return
    const controller = new AbortController()
    copying.current?.abort()
    copying.current = controller
    const requestVersion = ++version.current
    const current = () =>
      !controller.signal.aborted && version.current === requestVersion && !blocked.current
    setBusy(true)
    setManual(false)
    setStatus('Checking selected times…')
    try {
      await verifyAccess()
      if (!current()) return
      const metadata = await getEventType(handle, slug, controller.signal, team)
      if (!current()) return
      const allowed = metadata.allowedDurationsMinutes ?? [metadata.durationMinutes]
      if (!allowed.includes(durationMinutes)) {
        setPreviewVisible(false)
        setStatus(
          'This meeting length is no longer offered. Reload the saved event before trying again.',
        )
        return
      }
      // A maximum of ten short requests, never the hull between distant alternatives.
      const results = await Promise.allSettled(
        selected.map(async (slot) => {
          const end = new Date(Date.parse(slot.start) + durationMinutes * 60_000).toISOString()
          const slots = await eventSlots(
            handle,
            slug,
            team,
            durationMinutes,
          )(slot.start, end, controller.signal)
          return slots.some((item) => exact(item, slot))
        }),
      )
      if (!current()) return
      if (results.some((result) => result.status === 'rejected')) {
        setPreviewVisible(false)
        setStatus('We could not check the selected times. Nothing was copied. Please try again.')
        return
      }
      const unavailable = selected.filter((_, index) => {
        const result = results[index]
        return result?.status === 'fulfilled' && !result.value
      })
      if (unavailable.length) {
        setStale(unavailable.map((slot) => slot.start))
        setPreviewVisible(false)
        setStatus(
          'Some selected times are no longer offered. Nothing was copied. Remove those times explicitly before trying again.',
        )
        return
      }
      await verifyAccess()
      if (!current()) return
      const canonicalAddress = team
        ? { kind: 'team' as const, teamSlug: metadata.team?.slug ?? handle, slug: metadata.slug }
        : { kind: 'personal' as const, handle: metadata.handle, slug: metadata.slug }
      const snippet = formatSlotSnippet({
        publicUrl,
        address: canonicalAddress,
        title: metadata.title,
        durationMinutes,
        starts: selected.map((slot) => slot.start),
        locale,
        displayTimeZone,
      })
      setPreviewSource({ title: metadata.title, address: canonicalAddress })
      setPreviewVisible(true)
      try {
        if (kind === 'plain') {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable')
          await navigator.clipboard.writeText(snippet.text)
        } else {
          if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
            throw new Error('clipboard_unavailable')
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([snippet.text], { type: 'text/plain' }),
              'text/html': new Blob([snippet.html], { type: 'text/html' }),
            }),
          ])
        }
        if (current())
          setStatus(
            kind === 'plain'
              ? 'Plain text copied.'
              : 'Rich text copied with a plain-text fallback.',
          )
      } catch {
        if (!current()) return
        setManual(true)
        setStatus(
          'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.',
        )
        setTimeout(() => {
          if (current()) {
            preview.current?.focus()
            preview.current?.select()
          }
        }, 0)
      }
    } catch {
      if (current()) {
        setPreviewVisible(false)
        setStatus('We could not check the selected times. Nothing was copied. Please try again.')
      }
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{t('Copy open times into an email')}</h3>
      <p>
        {t('Choose 1–10 alternatives from the saved event type. Unsaved changes are not included.')}
      </p>
      <p>
        {t(
          'Availability is checked again when you copy. Times are not reserved, and each booking requires confirmation.',
        )}
      </p>
      {event.isHidden && (
        <p className="notice">
          {t(
            'This event type is unlisted. Anyone receiving or forwarding these links may open and book it.',
          )}
        </p>
      )}
      <fieldset disabled={disabled || busy}>
        <legend>{t('Email display')}</legend>
        <label htmlFor={`${id}-duration`}>{t('Meeting length')}</label>
        <select
          id={`${id}-duration`}
          value={durationMinutes}
          onChange={(change) => {
            invalidate()
            setSelected([])
            setStale([])
            setDuration(Number(change.target.value))
          }}
        >
          {event.allowedDurationsMinutes.map((duration) => (
            <option key={duration} value={duration}>
              {t('{0} minutes', { '0': duration })}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-language`}>{t('Email language')}</label>
        <select
          id={`${id}-language`}
          value={locale}
          onChange={(change) => {
            version.current += 1
            setManual(false)
            setStatus(null)
            setLocale(change.target.value as InterfaceLanguage)
          }}
        >
          {registeredLocales.map(({ code, nativeName }) => (
            <option key={code} value={code} lang={code}>
              {nativeName}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-zone`}>{t('Display time zone')}</label>
        <select
          id={`${id}-zone`}
          value={displayTimeZone}
          onChange={(change) => {
            version.current += 1
            setManual(false)
            setStatus(null)
            setZone(change.target.value)
          }}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <p className="hint">
          {t(
            'Language and display time zone change labels only. Booking pages use each invitee’s preferences.',
          )}
        </p>
        <label htmlFor={`${id}-date`}>{t('Availability date (UTC)')}</label>
        <input
          id={`${id}-date`}
          type="date"
          value={date}
          onChange={(change) => {
            if (change.target.value) setDate(change.target.value)
          }}
        />
      </fieldset>
      <fieldset disabled={disabled || busy || loading} aria-busy={loading}>
        <legend>{t('Available alternatives')}</legend>
        {loading ? (
          <p role="status">{t('Loading available times…')}</p>
        ) : loadError ? (
          <p>{t('We could not load available times. Please try again.')}</p>
        ) : offered.length === 0 ? (
          <p>{t('No times are offered on this date.')}</p>
        ) : (
          offered.map((slot) => {
            const checked = selected.some((item) => exact(item, slot))
            return (
              <label key={slot.start} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= 10}
                  onChange={() => choose(slot)}
                />
                {label(slot)}
              </label>
            )
          })
        )}
      </fieldset>
      {!loading && (
        <button
          type="button"
          className="button button-small"
          disabled={disabled || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          {t('Retry availability')}
        </button>
      )}
      <div aria-live="polite" role="status">
        <p>{t('{0} of 10 alternatives selected', { '0': selected.length })}</p>
      </div>
      {selected.length > 0 && (
        <fieldset disabled={disabled || busy}>
          <legend>{t('Selected alternatives')}</legend>
          <ul>
            {selected.map((slot) => (
              <li key={slot.start}>
                <span>{label(slot)}</span>{' '}
                {stale.includes(slot.start) && <strong>{t('No longer offered')}</strong>}{' '}
                <button
                  type="button"
                  className="button button-small"
                  aria-label={t('Remove {time}', { time: label(slot) })}
                  onClick={() => remove(slot)}
                >
                  {t('Remove time')}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <button
        type="button"
        className="button"
        disabled={disabled || busy || !selected.length || stale.length > 0}
        onClick={() => void showPreview()}
      >
        {t('Preview email')}
      </button>
      {previewVisible && !formatted && (
        <p role="alert">
          {t('The email preview could not be created. Please choose fewer times and try again.')}
        </p>
      )}
      {formatted && (
        <>
          <label htmlFor={`${id}-preview`}>{t('Complete plain-text email preview')}</label>
          <textarea
            id={`${id}-preview`}
            ref={preview}
            readOnly
            value={formatted.text}
            rows={Math.min(18, selected.length * 3 + 5)}
          />
          <div className="form-actions">
            <button
              type="button"
              className="button"
              disabled={disabled || busy}
              onClick={() => void copy('plain')}
            >
              {t('Copy plain text')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || busy}
              onClick={() => void copy('rich')}
            >
              {t('Copy rich text')}
            </button>
          </div>
          {manual && <p>{t('The full plain text above includes every booking link.')}</p>}
        </>
      )}
      <p role="status" aria-live="polite">
        {status && t(status)}
      </p>
    </section>
  )
}
