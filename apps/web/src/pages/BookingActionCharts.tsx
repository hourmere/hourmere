import type { Schemas } from '../api/client.ts'
import { useI18n } from '../i18n/runtime.tsx'

const actions = [
  ['created', 'Bookings created'],
  ['rescheduled', 'Reschedules'],
  ['cancelled', 'Cancellations'],
] as const

type ActivityDay = Pick<
  Schemas['BookingActivity']['data'][number],
  'date' | (typeof actions)[number][0]
>

export function shapeBookingActions(days: readonly ActivityDay[]) {
  const series = actions.map(([action, label]) => ({
    action,
    label,
    points: days.map((day) => ({ date: day.date, count: day[action] })),
  }))
  return {
    series,
    maxCount: Math.max(0, ...series.flatMap(({ points }) => points.map(({ count }) => count))),
  }
}

export function BookingActionCharts({
  report,
}: {
  report: Pick<Schemas['BookingActivity'], 'data' | 'startDate' | 'endDate' | 'totals'>
}) {
  const { t, formatLocale } = useI18n()
  const { series, maxCount } = shapeBookingActions(report.data)
  const number = new Intl.NumberFormat(formatLocale)
  // The server has already assigned these date labels in the reporting time zone.
  const date = new Intl.DateTimeFormat(formatLocale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const barWidth = Math.min(0.8, report.data.length / 8)

  return (
    <section className="analytics-charts" aria-labelledby="booking-actions">
      <h3 id="booking-actions">{t('Booking actions over time')}</h3>
      {maxCount === 0 ? (
        <p>
          {t(
            report.totals.noShows === 0
              ? 'No booking activity was recorded in this range.'
              : 'No booking actions were recorded in this range.',
          )}
        </p>
      ) : (
        <>
          <p className="hint">
            {t('The charts share a count scale. See the daily table below for exact counts.')}
          </p>
          <div className="analytics-chart-grid">
            {series.map(({ action, label, points }) => (
              <figure className="analytics-chart" key={action}>
                <figcaption>{t(label)}</figcaption>
                <div className="analytics-chart-plot" aria-hidden="true">
                  <div className="analytics-chart-counts">
                    <span>{number.format(maxCount)}</span>
                    <span>{number.format(0)}</span>
                  </div>
                  <svg
                    aria-hidden="true"
                    viewBox={`0 0 ${points.length} ${maxCount}`}
                    preserveAspectRatio="none"
                  >
                    {points.map(({ date, count }, index) =>
                      count > 0 ? (
                        <rect
                          key={date}
                          x={index + (1 - barWidth) / 2}
                          y={maxCount - count}
                          width={barWidth}
                          height={count}
                        />
                      ) : null,
                    )}
                  </svg>
                  <div className="analytics-chart-dates">
                    <span>{date.format(new Date(report.startDate))}</span>
                    {report.endDate !== report.startDate && (
                      <span>{date.format(new Date(report.endDate))}</span>
                    )}
                  </div>
                </div>
              </figure>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
