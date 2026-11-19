import { useId } from 'react'
import { BreakableText } from '../../components/BreakableText.tsx'
import { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { PollCandidate, PollResults } from './poll-results-api.ts'

const VOTER_STATUS = {
  pending: 'Verification pending',
  invited: 'Invited to vote',
  verified: 'Verified voter',
  withdrawn: 'Withdrawn voter',
} as const

const VOTE_LABEL = { yes: 'Yes', if_need_be: 'If need be', no: 'No' } as const

export const AVAILABILITY_LABEL = {
  available: 'Currently available',
  unavailable: 'Currently unavailable',
  unknown: 'Availability unknown',
} as const

export function PollResultsMatrix({
  results,
  candidates,
  showAvailability,
}: {
  results: PollResults
  candidates: PollCandidate[]
  showAvailability: boolean
}) {
  const { t, formatLocale } = useI18n()
  const headingId = useId()
  const matrixId = useId()
  const format = zoned(results.poll.displayTimeZone, formatLocale)
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('Votes')}</h2>
      <p>{t('Submitted ballots: {count}', { count: results.countedBallots })}</p>
      <p>
        {t(
          results.poll.visibility === 'aggregate'
            ? 'Verified voters can see totals. In a small poll, subtracting their own vote can reveal how someone else voted.'
            : 'Voters can see only their own votes. This results page is private to poll managers.',
        )}
      </p>
      {showAvailability && (
        <p className="hint">
          {t('Availability can change. Hourmere checks the chosen time again when you schedule.')}
        </p>
      )}
      <section
        className="meeting-poll-matrix"
        aria-labelledby={matrixId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: make the overflow region keyboard-scrollable
        tabIndex={0}
        data-layout-scroll="horizontal"
        data-testid="meeting-poll-matrix"
      >
        <table>
          <caption id={matrixId}>{t('Votes by voter and time')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('Voter')}</th>
              {candidates.map((candidate) => (
                <th scope="col" key={candidate.id}>
                  <time dateTime={candidate.startAt}>
                    {format.dateTimeRange(candidate.startAt, candidate.endAt)}
                  </time>
                  {showAvailability && (
                    <span className="meeting-poll-cell-detail">
                      {t(AVAILABILITY_LABEL[candidate.availability] ?? AVAILABILITY_LABEL.unknown)}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['yes', 'Yes'],
                ['ifNeedBe', 'If need be'],
                ['no', 'No'],
              ] as const
            ).map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{t(label)}</th>
                {candidates.map((candidate) => (
                  <td key={candidate.id}>{candidate[key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tbody>
            {results.roster.map((voter) => (
              <tr key={voter.voterId}>
                <th scope="row" data-private>
                  {voter.name}
                  <span className="meeting-poll-cell-detail">
                    <BreakableText>{voter.email}</BreakableText>
                  </span>
                  <span className="meeting-poll-cell-detail">
                    {t(VOTER_STATUS[voter.status] ?? 'Unknown')}
                  </span>
                </th>
                {candidates.map((candidate) => {
                  const vote = voter.votes.find(({ slotId }) => slotId === candidate.id)?.value
                  return <td key={candidate.id}>{t((vote && VOTE_LABEL[vote]) || 'No vote')}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  )
}
