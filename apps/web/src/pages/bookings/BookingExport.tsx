import { useId, useState } from 'react'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { useMe } from '../../session.tsx'

export interface ExportFilters {
  from?: string
  to?: string
  endAfter?: string
  endTo?: string
  status?: 'confirmed' | 'cancelled'
  eventTypeId?: string
  hostUserId?: string
  order?: 'asc' | 'desc'
}

/** Native downloads keep large CSV files out of the application's JavaScript heap. */
export function BookingExport({
  filters,
  timeZone,
  expectedOrganizationId,
  disabled = false,
}: {
  filters: ExportFilters
  timeZone: string
  expectedOrganizationId: string
  disabled?: boolean
}) {
  const { t } = useI18n()
  const me = useMe()
  const id = useId()
  const [from, setFrom] = useState(() => filters.from?.replace(/Z$/, '') ?? '')
  const [to, setTo] = useState(() => filters.to?.replace(/Z$/, '') ?? '')
  const [bom, setBom] = useState(true)
  const start = from ? Date.parse(`${from}Z`) : Number.NaN
  const end = to ? Date.parse(`${to}Z`) : Number.NaN
  const overlaps =
    (!filters.from || end > Date.parse(filters.from)) &&
    (!filters.to || start < Date.parse(filters.to))
  const valid =
    overlaps &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= 366 * 86_400_000
  const blocked = disabled || me.organization.id !== expectedOrganizationId
  const query = new URLSearchParams({ timeZone, expectedOrganizationId, bom: String(bom) })
  for (const key of [
    'endAfter',
    'endTo',
    'status',
    'eventTypeId',
    'hostUserId',
    'order',
  ] as const) {
    const value = filters[key]
    if (value !== undefined) query.set(key, value)
  }
  if (valid) {
    // The chosen range narrows the current filters; it never silently broadens them.
    query.set(
      'from',
      new Date(Math.max(start, filters.from ? Date.parse(filters.from) : start)).toISOString(),
    )
    query.set(
      'to',
      new Date(Math.min(end, filters.to ? Date.parse(filters.to) : end)).toISOString(),
    )
  }
  return (
    <details className="panel">
      <summary>{t('Export bookings as CSV')}</summary>
      <div className="stack">
        <p className="hint">
          {t('Choose a start-time range of at most 366 days. Current booking filters also apply.')}
        </p>
        <p>{t('This file contains personal data. Store and share it carefully.')}</p>
        <p className="hint">{t('CSV times use {zone} and UTC.', { zone: timeZone })}</p>
        <div className="field-grid">
          <Field id={`${id}-from`} label={t('Export starts at or after (UTC)')}>
            {(props) => (
              <input
                {...props}
                type="datetime-local"
                step="0.001"
                value={from}
                disabled={blocked}
                onChange={(event) => setFrom(event.target.value)}
              />
            )}
          </Field>
          <Field id={`${id}-to`} label={t('Export starts before (UTC)')}>
            {(props) => (
              <input
                {...props}
                type="datetime-local"
                step="0.001"
                value={to}
                disabled={blocked}
                onChange={(event) => setTo(event.target.value)}
              />
            )}
          </Field>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={bom}
            disabled={blocked}
            onChange={(event) => setBom(event.target.checked)}
          />
          {t('Include UTF-8 BOM for Excel')}
        </label>
        <div className="form-actions">
          {valid && !blocked ? (
            <a
              className="button"
              href={`/api/v1/bookings/export.csv?${query}`}
              download="bookings.csv"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('Download CSV')}
            </a>
          ) : (
            <button type="button" className="button" disabled>
              {t('Download CSV')}
            </button>
          )}
        </div>
      </div>
    </details>
  )
}
