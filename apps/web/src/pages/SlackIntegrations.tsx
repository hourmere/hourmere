import { type FormEvent, useCallback, useState } from 'react'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { isOrganizationContextChanged } from '../api/errors.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey } from '../i18n/translate.ts'
import { useSession } from '../session.tsx'
import { useConfirmLeave, useUnsavedChanges } from '../unsaved-changes.tsx'

type Destination = Schemas['SlackDestination']
const EVENTS = ['booking.created', 'booking.cancelled', 'booking.rescheduled'] as const
const LABELS: Record<(typeof EVENTS)[number], MessageKey> = {
  'booking.created': 'Booking created',
  'booking.cancelled': 'Booking cancelled',
  'booking.rescheduled': 'Booking rescheduled',
}

export function SlackIntegrations({ organizationId }: { organizationId: string }) {
  const { t } = useI18n()
  const { confirmReload } = useSession()
  const [open, setOpen] = useState(false)
  const confirmLeave = useConfirmLeave()
  return (
    <section className="panel slack-integrations" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading">{t('Integrations')}</h2>
      <button
        type="button"
        className="button"
        aria-expanded={open}
        aria-controls="slack-settings"
        onClick={() => {
          if (!open || confirmLeave()) setOpen(!open)
        }}
      >
        {t('Slack booking notifications')}
      </button>
      {open && (
        <div id="slack-settings">
          <SlackSettings
            key={organizationId}
            organizationId={organizationId}
            onReload={confirmReload}
          />
        </div>
      )}
    </section>
  )
}

function SlackSettings({
  organizationId,
  onReload,
}: {
  organizationId: string
  onReload: () => void
}) {
  const { t } = useI18n()
  const [contextChanged, setContextChanged] = useState(false)
  const headers = { 'X-Expected-Organization-Id': organizationId }
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await unwrap(
          api.GET('/api/v1/slack-destinations', {
            signal,
            headers: { 'X-Expected-Organization-Id': organizationId },
          }),
        )
      } catch (error) {
        if (!signal.aborted && isOrganizationContextChanged(error)) setContextChanged(true)
        throw error
      }
    },
    [organizationId],
  )
  const [destinations, reload] = useLoad(load)
  const [message, setMessage] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useMounted()
  async function action(run: () => Promise<unknown>, success: MessageKey) {
    setBusy(true)
    setMessage(null)
    try {
      await run()
      if (!mounted.current) return
      setMessage(success)
      reload()
    } catch (error) {
      if (!mounted.current) return
      if (isOrganizationContextChanged(error)) setContextChanged(true)
      setMessage(
        'Could not update Slack notifications. Check your access and settings, then try again.',
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  if (contextChanged)
    return (
      <div role="alert">
        <p>{t('Your team context changed. Reload before making changes.')}</p>
        <button className="button" type="button" onClick={onReload}>
          {t('Reload')}
        </button>
      </div>
    )
  return (
    <div className="stack">
      <p>
        {t(
          'Send event titles, booking IDs, times, status and admin links to Slack. Personal destinations also include the invitee name. Email addresses, custom answers and meeting links are never included.',
        )}
      </p>
      {destinations.status === 'loading' && (
        <p role="status">{t('Loading Slack notifications…')}</p>
      )}
      {destinations.status === 'error' && (
        <div role="alert">
          <p>
            {t(
              'Could not load Slack notifications. Only organization owners and admins can manage them.',
            )}
          </p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {message && <p role="status">{t(message)}</p>}
      {destinations.status === 'ready' && (
        <>
          {destinations.data.length === 0 && <p>{t('No Slack destination yet.')}</p>}
          {destinations.data.map((destination) => (
            <div className="stack" key={destination.id}>
              <p className="mono">
                <BreakableText>{destination.url}</BreakableText>
              </p>
              {!destination.isActive && (
                <p role="status">
                  {destination.pauseReason === 'url_rejected'
                    ? t(
                        'Slack rejected this webhook URL, so notifications are paused. Replace the URL, then enable notifications.',
                      )
                    : t('Slack notifications are paused.')}
                </p>
              )}
              <SlackForm
                key={destination.updatedAt}
                destination={destination}
                organizationId={organizationId}
                disabled={busy}
                onSave={(body) =>
                  action(
                    () =>
                      unwrap(
                        api.PATCH('/api/v1/slack-destinations/{id}', {
                          params: { path: { id: destination.id } },
                          headers,
                          body,
                        }),
                      ),
                    'Slack destination saved.',
                  )
                }
              />
              <div className="form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || !destination.isActive}
                  onClick={() =>
                    void action(
                      () =>
                        unwrap(
                          api.POST('/api/v1/slack-destinations/{id}/test', {
                            params: { path: { id: destination.id } },
                            headers,
                          }),
                        ),
                      'Slack test message queued. This does not confirm delivery.',
                    )
                  }
                >
                  {t('Send test message')}
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(t('Delete this Slack destination and its delivery history?'))
                    )
                      void action(
                        () =>
                          unwrap(
                            api.DELETE('/api/v1/slack-destinations/{id}', {
                              params: { path: { id: destination.id } },
                              headers,
                            }),
                          ),
                        'Slack destination deleted.',
                      )
                  }}
                >
                  {t('Delete Slack destination')}
                </button>
              </div>
            </div>
          ))}
          {destinations.data.length === 0 && (
            <SlackForm
              organizationId={organizationId}
              disabled={busy}
              onSave={(body) =>
                action(
                  () =>
                    unwrap(
                      api.POST('/api/v1/slack-destinations', {
                        headers,
                        body: { ...body, url: body.url ?? '', events: body.events ?? [...EVENTS] },
                      }),
                    ),
                  'Slack destination saved.',
                )
              }
            />
          )}
        </>
      )}
    </div>
  )
}

type Draft = {
  url?: string
  events?: Destination['events']
  isActive?: boolean
  eventTypeId?: string | null
}
function SlackForm({
  organizationId,
  destination,
  disabled,
  onSave,
}: {
  organizationId: string
  destination?: Destination
  disabled: boolean
  onSave: (body: Draft) => Promise<void>
}) {
  const { t } = useI18n()
  const loadTypes = useCallback(
    async (signal: AbortSignal) => {
      const result = await unwrap(api.GET('/api/v1/event-types', { signal }))
      // This older read endpoint has no context header; never display another space's rows.
      if (result.data.some((event) => event.organizationId !== organizationId))
        throw new Error('Context changed')
      return result.data
    },
    [organizationId],
  )
  const [types, reloadTypes] = useLoad(loadTypes)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<Destination['events']>(destination?.events ?? [...EVENTS])
  const [active, setActive] = useState(destination?.isActive ?? true)
  const [filter, setFilter] = useState(destination?.eventTypeId ?? '')
  const [invalid, setInvalid] = useState(false)
  const dirty =
    Boolean(url) ||
    filter !== (destination?.eventTypeId ?? '') ||
    active !== (destination?.isActive ?? true) ||
    events.join() !== (destination?.events ?? [...EVENTS]).join()
  useUnsavedChanges(dirty)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!events.length || (!destination && !url.trim())) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    const body: Draft = {
      ...(!destination || events.join() !== destination.events.join() ? { events } : {}),
      ...(!destination || active !== destination.isActive ? { isActive: active } : {}),
      ...(!destination || filter !== (destination.eventTypeId ?? '')
        ? { eventTypeId: filter || null }
        : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
    }
    // Do not retain a bearer URL in the UI after submitting, including failed saves.
    setUrl('')
    await onSave(body)
  }
  return (
    <form className="stack" onSubmit={submit} aria-label={t('Configure Slack notifications')}>
      {invalid && (
        <p role="alert">{t('Enter a Slack webhook URL and choose at least one event.')}</p>
      )}
      <fieldset className="form-fieldset stack" disabled={disabled}>
        <label>
          {destination ? t('Replacement Slack webhook URL') : t('Slack incoming-webhook URL')}
          <input
            type="password"
            autoComplete="new-password"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            maxLength={2048}
          />
        </label>
        <p className="hint">
          {t(
            'Use an HTTPS incoming-webhook URL from hooks.slack.com. Keep it private. Leave replacement blank to keep the saved URL.',
          )}
        </p>
        <fieldset className="form-fieldset">
          <legend>{t('Events to post')}</legend>
          {EVENTS.map((event) => (
            <label key={event}>
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(e) =>
                  setEvents((current) =>
                    e.target.checked
                      ? [...current, event]
                      : current.filter((item) => item !== event),
                  )
                }
              />
              {t(LABELS[event])}
            </label>
          ))}
        </fieldset>
        <label>
          {t('Event type filter')}
          <select
            value={filter}
            disabled={types.status !== 'ready'}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">{t('All event types')}</option>
            {filter &&
              (types.status !== 'ready' || !types.data.some((event) => event.id === filter)) && (
                <option value={filter}>{t('Saved event type — details unavailable')}</option>
              )}
            {types.status === 'ready' &&
              types.data.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
          </select>
        </label>
        {types.status === 'loading' && <p role="status">{t('Loading event type choices…')}</p>}
        {types.status === 'error' && (
          <div role="alert">
            <p>{t('Could not load event type choices. Your saved filter is unchanged.')}</p>
            <button type="button" className="button" onClick={reloadTypes}>
              {t('Try again')}
            </button>
          </div>
        )}
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          {t('Enable Slack notifications')}
        </label>
        <button
          className="button button-primary"
          type="submit"
          disabled={Boolean(destination) && !dirty}
        >
          {disabled ? t('Saving…') : t('Save Slack destination')}
        </button>
      </fieldset>
    </form>
  )
}
