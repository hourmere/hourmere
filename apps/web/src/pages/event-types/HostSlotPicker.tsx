import { type InterfaceLanguage, registeredLocales } from '@hourmere/core/language'
import {
  formatSlotLabel,
  formatSlotSnippet,
  resolveSnippetLocale,
  resolveSnippetTimeZone,
  type SlotSnippet,
  SlotSnippetError,
  snippetTimeZone,
} from '@hourmere/core/slot-snippet'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { EventType, Profile } from '../../api/resources.ts'
import { timeZoneNames } from '../../components/TimeZonePicker.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { codeOf, eventSlots, getEventType, type Slot } from '../../public/api.ts'
import { addDays, parseDateKey } from '../../public/calendar.ts'
import { dateKeyIn, instantOf } from '../../public/time.ts'

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

function formattingMessage(error: unknown): MessageKey {
  if (error instanceof SlotSnippetError) {
    if (error.code === 'invalid_title')
      return 'The saved event title is invalid. Reload the saved event type and try again.'
    if (error.code === 'invalid_address')
      return 'The saved booking address is invalid. Reload the saved event type and try again.'
    if (error.code === 'snippet_too_large')
      return 'The email preview could not be created. Please choose fewer times and try again.'
  }
  return 'The email preview could not be created. Reload the saved event type and try again.'
}

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
  const [date, setDate] = useState(() => dateKeyIn(Date.now(), displayTimeZone))
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
  const retry = useRef<HTMLButtonElement>(null)
  const promiseClipboard = useRef(false)
  const handle = address.kind === 'team' ? address.teamSlug : address.handle
  const team = address.kind === 'team'
  const slug = address.slug
  const zones = useMemo(
    () =>
      [...new Set(['UTC', displayTimeZone, ...timeZoneNames()])]
        .filter((zone) => {
          try {
            snippetTimeZone(zone)
            return true
          } catch {
            return false
          }
        })
        .sort(),
    [displayTimeZone],
  )
  const label = (slot: Slot) => {
    try {
      return formatSlotLabel(slot.start, slot.end, locale, displayTimeZone)
    } catch {
      return t('This time could not be displayed. Please try another display time zone.')
    }
  }
  const formatResult = useMemo(() => {
    if (!previewVisible || !selected.length || stale.length) return { snippet: null, error: null }
    try {
      return {
        snippet: formatSlotSnippet({
          publicUrl,
          address: previewSource.address,
          title: previewSource.title,
          durationMinutes,
          starts: selected.map((slot) => slot.start),
          locale,
          displayTimeZone,
        }),
        error: null,
      }
    } catch (error) {
      return { snippet: null, error: formattingMessage(error) }
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

  const formatted = formatResult.snippet

  // Probe promise data without touching the system clipboard. Older implementations
  // may accept the constructor but stringify promises instead of awaiting them.
  useEffect(() => {
    let active = true
    promiseClipboard.current = false
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return
      const probe = new Blob(['promise support'], { type: 'text/plain' })
      const item = new ClipboardItem({ 'text/plain': Promise.resolve(probe) })
      void item
        .getType('text/plain')
        .then((value) => {
          if (active)
            promiseClipboard.current = value.size === probe.size && value.type === probe.type
        })
        .catch(() => {})
    } catch {
      // A plain-text/manual fallback remains available after the same rechecks.
    }
    return () => {
      active = false
    }
  }, [])

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
        const start = instantOf(parseDateKey(date), 0, 0, displayTimeZone)
        const boundary = instantOf(parseDateKey(addDays(date, 1)), 0, 0, displayTimeZone)
        // Include cross-midnight meetings within one display-zone calendar day (23–25 hours at DST).
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
          const middle = start + (boundary - start) / 2
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
  }, [date, durationMinutes, reload, handle, slug, team, disabled, displayTimeZone])

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
    setStatus('Checking that you can preview these times…')
    try {
      await verifyAccess()
      if (!current()) return
      setPreviewSource({ title: event.title, address })
      setPreviewVisible(true)
      try {
        formatSlotSnippet({
          publicUrl,
          address,
          title: event.title,
          durationMinutes,
          starts: selected.map((slot) => slot.start),
          locale,
          displayTimeZone,
        })
        setStatus('Email preview ready.')
      } catch {
        setStatus(null)
      }
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
    const stop = () => {
      // Move focus before removing the preview and its copy controls.
      retry.current?.focus()
      setPreviewVisible(false)
    }
    async function prepare(): Promise<SlotSnippet> {
      await verifyAccess()
      if (!current()) throw new Error('copy_cancelled')
      const metadata = await getEventType(handle, slug, controller.signal, team)
      if (!current()) throw new Error('copy_cancelled')
      const allowed = metadata.allowedDurationsMinutes ?? [metadata.durationMinutes]
      if (!allowed.includes(durationMinutes)) {
        stop()
        setStatus(
          'This meeting length is no longer offered. Reload the saved event type before trying again.',
        )
        throw new Error('copy_recheck_failed')
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
      if (!current()) throw new Error('copy_cancelled')
      if (results.some((result) => result.status === 'rejected')) {
        stop()
        setStatus('We could not check the selected times. Nothing was copied. Please try again.')
        throw new Error('copy_recheck_failed')
      }
      const unavailable = selected.filter((_, index) => {
        const result = results[index]
        return result?.status === 'fulfilled' && !result.value
      })
      if (unavailable.length) {
        setStale(unavailable.map((slot) => slot.start))
        stop()
        setStatus(
          'Some selected times are no longer offered. Nothing was copied. Remove those times manually before trying again.',
        )
        throw new Error('copy_recheck_failed')
      }
      await verifyAccess()
      if (!current()) throw new Error('copy_cancelled')
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
      return snippet
    }
    // Register the write in the click's activation window, before starting any I/O.
    // Both representations share one recheck promise: a failure rejects the entire item.
    let resolveSnippet!: (snippet: SlotSnippet) => void
    let rejectSnippet!: (error: unknown) => void
    const checked = new Promise<SlotSnippet>((resolve, reject) => {
      resolveSnippet = resolve
      rejectSnippet = reject
    })
    void checked.catch(() => {})
    let writing: Promise<void> | null = null
    if (promiseClipboard.current) {
      const plain = checked.then((snippet) => new Blob([snippet.text], { type: 'text/plain' }))
      const html = checked.then((snippet) => new Blob([snippet.html], { type: 'text/html' }))
      // A browser may reject write before consuming the data promises.
      void plain.catch(() => {})
      void html.catch(() => {})
      try {
        const item = new ClipboardItem(
          kind === 'rich' ? { 'text/plain': plain, 'text/html': html } : { 'text/plain': plain },
        )
        writing = navigator.clipboard.write([item])
        void writing.catch(() => {})
      } catch {
        writing = Promise.reject(new Error('clipboard_unavailable'))
        void writing.catch(() => {})
      }
    }
    try {
      let snippet: SlotSnippet
      try {
        snippet = await prepare()
        resolveSnippet(snippet)
      } catch (error) {
        rejectSnippet(error)
        if (current()) {
          stop()
          if (error instanceof SlotSnippetError) setStatus(formattingMessage(error))
          else
            setStatus((previous) =>
              previous === 'Checking selected times…'
                ? 'We could not check the selected times. Nothing was copied. Please try again.'
                : previous,
            )
        }
        return
      }
      try {
        if (writing) await writing
        else if (kind === 'plain' && navigator.clipboard?.writeText)
          await navigator.clipboard.writeText(snippet.text)
        else throw new Error('clipboard_unavailable')
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
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section className="panel" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{t('Copy open times into an email')}</h3>
      <p>
        {t(
          'Choose 1–10 available times for the saved event type. Unsaved changes are not included.',
        )}
      </p>
      <p>
        {t(
          'Availability is checked again when you copy. Times are not reserved and may become unavailable. Invitees must confirm their bookings on the booking page.',
        )}
      </p>
      {event.isHidden && (
        <p className="notice">
          {t(
            'This event type is unlisted. Anyone with these links can open the booking page and book an available time.',
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
              {t('{0} min', { '0': duration })}
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
            'The language and time zone selected here apply only to the email snippet. Booking pages use each invitee’s preferences.',
          )}
        </p>
        <label htmlFor={`${id}-date`}>
          {t('Availability date ({zone})', { zone: displayTimeZone })}
        </label>
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
        <legend>{t('Available times')}</legend>
        {loading ? (
          <p role="status">{t('Loading available times…')}</p>
        ) : loadError ? (
          <p role="alert">{t('We could not load available times. Please try again.')}</p>
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
      <button
        type="button"
        className="button button-small"
        ref={retry}
        disabled={disabled}
        aria-disabled={busy || loading}
        onClick={() => {
          if (!busy && !loading) setReload((value) => value + 1)
        }}
      >
        {t('Check availability again')}
      </button>
      <div aria-live="polite" role="status">
        <p>{t('Selected times: {0} (maximum 10)', { '0': selected.length })}</p>
      </div>
      {selected.length > 0 && (
        <fieldset disabled={disabled || busy}>
          <legend>{t('Selected times')}</legend>
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
        <p role="alert">{formatResult.error && t(formatResult.error)}</p>
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
              disabled={disabled}
              aria-disabled={busy}
              onClick={(click) => {
                click.currentTarget.focus()
                void copy('plain')
              }}
            >
              {t('Copy plain text')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={disabled}
              aria-disabled={busy}
              onClick={(click) => {
                click.currentTarget.focus()
                void copy('rich')
              }}
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
