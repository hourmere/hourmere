import { useId, useState } from 'react'
import { BreakableText } from '../../components/BreakableText.tsx'
import { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { BOOKING } from '../../limits.ts'
import { AVAILABILITY_LABEL } from './PollResultsMatrix.tsx'
import {
  eligibleVoters,
  type FinalizeBody,
  type PollCandidate,
  type PollResults,
} from './poll-results-api.ts'
import { pollTimeRange } from './poll-time.ts'

export function PollFinalizeForm({
  results,
  candidates,
  disabled,
  busy,
  onRefresh,
  onFinalize,
}: {
  results: PollResults
  candidates: PollCandidate[]
  disabled: boolean
  busy: boolean
  onRefresh: (() => void) | undefined
  onFinalize: (body: FinalizeBody) => void
}) {
  const { t, formatLocale } = useI18n()
  const headingId = useId()
  const [slotId, setSlotId] = useState('')
  const [bookerId, setBookerId] = useState('')
  const [guests, setGuests] = useState<string[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const format = zoned(results.poll.displayTimeZone, formatLocale)
  const slot = candidates.find(
    ({ id, availability }) => id === slotId && availability === 'available',
  )
  const eligible = slot ? eligibleVoters(results.roster, slot.id) : []
  const booker = eligible.find(({ voterId }) => voterId === bookerId)
  const attendeeIds = booker ? [booker.voterId, ...guests] : []
  const attendees = eligible.filter(({ voterId }) => attendeeIds.includes(voterId))
  const conditional = attendees.some(({ votes }) =>
    votes.some((vote) => vote.slotId === slotId && vote.value === 'if_need_be'),
  )
  const ready = slot && booker && (!conditional || acknowledged)
  const capReached = guests.length >= BOOKING.maxGuests
  const hasTime = candidates.some(({ availability }) => availability === 'available')

  return (
    <section className="panel" aria-labelledby={headingId} data-testid="meeting-poll-finalize">
      <h2 id={headingId}>{t('Schedule meeting')}</h2>
      <p>
        {t(
          'Scheduling creates a booking, ends voting and sends the outcome. The booker can manage the whole meeting.',
        )}
      </p>
      {!hasTime ? (
        <>
          <p className="hint">{t('No candidate time can be selected right now.')}</p>
          {onRefresh && (
            <button
              type="button"
              className="button button-small"
              onClick={onRefresh}
              disabled={disabled}
            >
              {t('Refresh results')}
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (disabled || !ready) return
            onFinalize({
              slotId: slot.id,
              bookerVoterId: booker.voterId,
              attendeeVoterIds: attendeeIds,
              expectedResultsRevision: results.resultsRevision,
              expectedBallotRevisions: Object.fromEntries(
                attendees.map(({ voterId, ballotRevision }) => [voterId, ballotRevision]),
              ),
              acknowledgeConditional: conditional && acknowledged,
            })
          }}
        >
          <fieldset className="form-fieldset stack" disabled={disabled}>
            <legend className="visually-hidden">{t('Scheduling choices')}</legend>
            <label className="field">
              <span>{t('Meeting time')}</span>
              <select
                required
                value={slotId}
                onChange={(event) => {
                  setSlotId(event.target.value)
                  setBookerId('')
                  setGuests([])
                  setAcknowledged(false)
                }}
              >
                <option value="">{t('Choose a time')}</option>
                {candidates.map((candidate) => (
                  <option
                    key={candidate.id}
                    value={candidate.id}
                    disabled={candidate.availability !== 'available'}
                  >
                    {t('{time} ({availability})', {
                      time: pollTimeRange(format, candidate.startAt, candidate.endAt),
                      availability: t(
                        AVAILABILITY_LABEL[candidate.availability] ?? AVAILABILITY_LABEL.unknown,
                      ),
                    })}
                  </option>
                ))}
              </select>
            </label>
            {slot && eligible.length === 0 && (
              <p className="hint">{t('No verified voters agreed to attend at this time.')}</p>
            )}
            {eligible.length > 0 && (
              <label className="field">
                <span>{t('Booker')}</span>
                <select
                  required
                  value={bookerId}
                  data-private
                  onChange={(event) => {
                    const id = event.target.value
                    setBookerId(id)
                    setGuests(guests.filter((guest) => guest !== id))
                    setAcknowledged(false)
                  }}
                >
                  <option value="">{t('Choose a booker')}</option>
                  {eligible.map((voter) => (
                    <option key={voter.voterId} value={voter.voterId} dir="auto">
                      {t('{name} ({email})', { name: voter.name, email: voter.email })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {booker && eligible.length > 1 && (
              <fieldset className="form-fieldset meeting-poll-attendees">
                <legend>{t('Additional attendees')}</legend>
                <p className="hint">
                  {t('Choose up to {count} additional attendees.', { count: BOOKING.maxGuests })}
                </p>
                <div className="meeting-poll-voter-options">
                  {eligible
                    .filter(({ voterId }) => voterId !== booker.voterId)
                    .map((voter) => {
                      const selected = guests.includes(voter.voterId)
                      return (
                        <label key={voter.voterId} className="check-label">
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={!selected && capReached}
                            onChange={(event) => {
                              setGuests(
                                event.target.checked
                                  ? [...guests, voter.voterId]
                                  : guests.filter((id) => id !== voter.voterId),
                              )
                              setAcknowledged(false)
                            }}
                          />
                          <span data-private>
                            <bdi>{voter.name}</bdi>
                            <span className="meeting-poll-cell-detail">
                              <bdi dir="ltr">
                                <BreakableText>{voter.email}</BreakableText>
                              </bdi>
                            </span>
                          </span>
                        </label>
                      )
                    })}
                </div>
                {capReached && (
                  <p className="hint" role="status">
                    {t('Attendee limit reached ({count} including the booker).', {
                      count: BOOKING.maxGuests + 1,
                    })}
                  </p>
                )}
              </fieldset>
            )}
            {conditional && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{t('I acknowledge the selected conditional votes.')}</span>
              </label>
            )}
            <div>
              <button type="submit" className="button button-primary" disabled={!ready}>
                {t(busy ? 'Scheduling…' : 'Schedule meeting')}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  )
}
