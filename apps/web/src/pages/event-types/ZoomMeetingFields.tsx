import { Link } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { Field, type FieldErrors } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PATHS } from '../../paths.ts'
import type { EventTypeDraft } from './event-type-form.ts'

const load = (signal: AbortSignal) => unwrap(api.GET('/api/v1/conference-connections', { signal }))

/** Mounted only after an explicit automatic opt-in by the actual signed-in host. */
export function ZoomMeetingFields({
  draft,
  errors,
  enabled,
  userId,
  personal,
  session,
  set,
}: {
  draft: EventTypeDraft
  errors: FieldErrors
  enabled: boolean
  userId: string
  personal: boolean
  session: boolean
  set: <K extends keyof EventTypeDraft>(key: K, value: EventTypeDraft[K]) => void
}) {
  const { t } = useI18n()
  const ownHost =
    session &&
    draft.schedulingType === 'individual' &&
    (personal || (draft.hostUserIds.length === 1 && draft.hostUserIds[0] === userId))
  return (
    <div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={draft.autoCreateZoom}
          disabled={(!enabled || !ownHost) && !draft.autoCreateZoom}
          onChange={(e) => set('autoCreateZoom', e.target.checked)}
        />
        {t('Create a unique Zoom meeting for each booking')}
      </label>
      <p className="hint">
        {t(
          'Choose your own authorized meetings account. Final invitations wait for the link. A Google calendar is optional.',
        )}
      </p>
      {!enabled && <p>{t('Automatic Zoom meetings are disabled on this instance.')}</p>}
      {!ownHost && (
        <p>{t('The assigned host must configure Zoom in their own signed-in session.')}</p>
      )}
      {draft.autoCreateZoom && enabled && ownHost && (
        <ZoomAccounts draft={draft} errors={errors} set={set} />
      )}
    </div>
  )
}
function ZoomAccounts({
  draft,
  errors,
  set,
}: Pick<Parameters<typeof ZoomMeetingFields>[0], 'draft' | 'errors' | 'set'>) {
  const { t, ui } = useI18n()
  const [state, reload] = useLoad(load)
  const accounts =
    state.status === 'ready'
      ? state.data.data.filter((c) => c.mode === 'meetings' && c.status === 'active')
      : []
  return (
    <div>
      {state.status === 'loading' && <p role="status">{t('Loading conference accounts…')}</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>{ui(state.message)}</p>
          <button type="button" onClick={reload}>
            {t('Retry')}
          </button>
        </div>
      )}
      <Field
        id="zoomConnectionId"
        label={t('Zoom meetings account')}
        error={errors.zoomConnectionId}
      >
        {(props) => (
          <select
            {...props}
            value={draft.zoomConnectionId}
            disabled={state.status !== 'ready'}
            onChange={(e) => set('zoomConnectionId', e.target.value)}
          >
            <option value="">{t('Choose an account')}</option>
            {draft.zoomConnectionId && !accounts.some((c) => c.id === draft.zoomConnectionId) && (
              <option value={draft.zoomConnectionId}>
                {t('Saved account — unavailable for a new selection')}
              </option>
            )}
            {accounts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName || c.accountEmail || t('Zoom account')}
              </option>
            ))}
          </select>
        )}
      </Field>
      {state.status === 'ready' && accounts.length === 0 && (
        <p>
          {t(
            'No active Zoom meetings account is available. Authorize meeting permissions in Conference accounts first.',
          )}
        </p>
      )}
      <Link to={PATHS.conferences}>{t('Conference accounts')}</Link>
    </div>
  )
}
