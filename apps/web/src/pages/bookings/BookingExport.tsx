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

/** Prepare the file before saving so failed responses never become CSV downloads. */
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
  const [downloading, setDownloading] = useState(false)
  const [failed, setFailed] = useState(false)
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
  async function download() {
    setFailed(false)
    setDownloading(true)
    try {
      const response = await fetch(`/api/v1/bookings/export.csv?${query}`, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(300_000),
        headers: { accept: 'text/csv' },
      })
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'text/csv') {
        await response.body?.cancel()
        throw new Error('download_failed')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = 'bookings.csv'
      link.click()
      // Allow the browser to start consuming the object URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      setFailed(true)
    } finally {
      setDownloading(false)
    }
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
          <Field id={`${id}-from`} label={t('Bookings starting at or after (UTC)')}>
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
          <Field id={`${id}-to`} label={t('Bookings starting before (UTC)')}>
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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={bom}
            disabled={blocked}
            onChange={(event) => setBom(event.target.checked)}
          />
          {t('Include UTF-8 BOM for Excel')}
        </label>
        {failed && (
          <p className="alert alert-error" role="alert">
            {t('Could not download CSV. Check the booking range and try again shortly.')}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button"
            disabled={!valid || blocked || downloading}
            onClick={() => void download()}
          >
            {t('Download CSV')}
          </button>
        </div>
      </div>
    </details>
  )
}
