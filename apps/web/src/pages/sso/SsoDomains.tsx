import { type FormEvent, type Ref, useEffect, useId, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import type { operations } from '../../api/schema.d.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { Field } from '../../components/forms.tsx'
import { browserTimeZone, zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import type { SsoDomain, SsoMutation } from './setup.ts'

type DnsChallenge =
  operations['createSsoDomainChallenge']['responses'][201]['content']['application/json']

const statusLabels = new Map<string, MessageKey>([
  ['pending', 'Awaiting DNS verification'],
  ['verified', 'Verified'],
  ['failed', 'Verification failed'],
  ['expired', 'Expired'],
])

type DomainAction = { kind: 'rotate' | 'retire'; domain: SsoDomain }

function comparableDomainName(value: string): string | undefined {
  if (/[\s/\\?#:@*%]/u.test(value)) return undefined
  // The URL parser normalizes IDNA just as the server does for a valid hostname.
  try {
    return new URL(`https://${value}`).hostname.replace(/\.$/, '')
  } catch {
    return undefined
  }
}

export function SsoDomains({
  domains,
  busy,
  mutate,
  organizationId,
  rememberDomain,
}: {
  domains: SsoDomain[]
  busy: boolean
  mutate: SsoMutation
  organizationId: string
  rememberDomain: (domain: SsoDomain) => void
}) {
  const { t } = useI18n()
  const formId = useId()
  const domainsId = useId()
  const [name, setName] = useState('')
  const [challenge, setChallenge] = useState<DnsChallenge | null>(null)
  const [confirmation, setConfirmation] = useState<DomainAction | null>(null)
  const [retired, setRetired] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const domainsHeading = useRef<HTMLHeadingElement>(null)
  const actionButton = useRef<HTMLButtonElement | null>(null)
  const challengeNode = useRef<HTMLElement>(null)
  const challengeVisit = useRef(0)
  const header = { 'X-Expected-Organization-Id': organizationId }

  useEffect(() => {
    function clearRecord() {
      // Hide the record in any page snapshot kept for back/forward navigation.
      challengeNode.current?.setAttribute('hidden', '')
      challengeVisit.current++
      setChallenge(null)
    }
    window.addEventListener('pagehide', clearRecord)
    return () => window.removeEventListener('pagehide', clearRecord)
  }, [])

  function generate(domain: string) {
    setChallenge(null)
    setRetired(false)
    const visit = challengeVisit.current
    return mutate(
      (signal) =>
        unwrap(
          api.POST('/api/v1/team/sso/domains', { params: { header }, body: { domain }, signal }),
        ),
      (result) => {
        rememberDomain(result.domain)
        if (challengeVisit.current === visit) setChallenge(result)
        setName('')
      },
    )
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = name.trim()
    if (!value || busy) return
    const comparable = comparableDomainName(value)
    const known = domains.find((domain) => domain.name === comparable)
    if (known) {
      actionButton.current = null
      setConfirmation({ kind: 'rotate', domain: known })
    } else {
      setConfirmation(null)
      void generate(value)
    }
  }

  function verify(domain: SsoDomain) {
    setChallenge(null)
    setRetired(false)
    setConfirmation(null)
    void mutate(
      (signal) =>
        unwrap(
          api.POST('/api/v1/team/sso/domains/{domainId}/verify', {
            params: { header, path: { domainId: domain.id } },
            body: { expectedGeneration: domain.generation },
            signal,
          }),
        ),
      ({ domain: verified }) => rememberDomain(verified),
    )
  }

  function confirm({ kind, domain }: DomainAction) {
    setConfirmation(null)
    if (kind === 'rotate') {
      void generate(domain.name)
      return
    }
    setRetired(false)
    setChallenge(null)
    void mutate(
      (signal) =>
        unwrap(
          api.DELETE('/api/v1/team/sso/domains/{domainId}', {
            params: { header, path: { domainId: domain.id } },
            body: { expectedGeneration: domain.generation },
            signal,
          }),
        ),
      ({ deleted }) => {
        if (!deleted) return
        rememberDomain({ ...domain, status: 'retired' })
        setRetired(true)
        domainsHeading.current?.focus()
      },
    )
  }

  return (
    <>
      <section className="panel" aria-labelledby={formId}>
        <h2 id={formId}>{t('DNS verification')}</h2>
        <form className="stack" onSubmit={submit}>
          <Field
            id={`${formId}-name`}
            label={t('Domain name')}
            hint={t(
              'Enter the exact domain to verify. Generating a challenge for an existing domain resets its verification.',
            )}
          >
            {(props) => (
              <input
                {...props}
                ref={input}
                required
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={1024}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            )}
          </Field>
          <div>
            <button className="button button-primary" type="submit" disabled={busy || !name.trim()}>
              {t('Generate DNS challenge')}
            </button>
          </div>
        </form>
      </section>
      {/* The raw record belongs to this visit of the domain page only. */}
      {challenge && (
        <ChallengeRecord
          key={`${challenge.domain.id}:${challenge.domain.generation}`}
          challenge={challenge}
          disclosure={challengeNode}
          onDismiss={() => {
            setChallenge(null)
            input.current?.focus()
          }}
        />
      )}
      <section className="panel" aria-labelledby={domainsId}>
        <h2 id={domainsId} ref={domainsHeading} tabIndex={-1}>
          {t('Available domains')}
        </h2>
        <p className="hint">
          {t('Domains from your providers and domains added in this visit appear here.')}
        </p>
        {retired && <p role="status">{t('Domain retired.')}</p>}
        {domains.map((domain) => (
          <article key={domain.id}>
            <h3 className="user-content">{domain.name}</h3>
            <p aria-live="polite">{t(statusLabels.get(domain.status) ?? 'Verification unknown')}</p>
            <div className="form-actions">
              <button
                className="button button-small"
                type="button"
                disabled={busy}
                aria-label={t('Verify domain {domain}', { domain: domain.name })}
                onClick={() => verify(domain)}
              >
                {t('Verify domain')}
              </button>
              <button
                className="button button-small"
                type="button"
                disabled={busy}
                aria-label={t('Rotate challenge for {domain}', { domain: domain.name })}
                onClick={(event) => {
                  actionButton.current = event.currentTarget
                  setConfirmation({ kind: 'rotate', domain })
                }}
              >
                {t('Rotate challenge')}
              </button>
              <button
                className="button button-small"
                type="button"
                disabled={busy}
                aria-label={t('Retire domain {domain}', { domain: domain.name })}
                onClick={(event) => {
                  actionButton.current = event.currentTarget
                  setConfirmation({ kind: 'retire', domain })
                }}
              >
                {t('Retire domain')}
              </button>
            </div>
            {confirmation?.domain.id === domain.id && (
              <DomainConfirmation
                key={confirmation.kind}
                action={confirmation}
                onCancel={() => {
                  setConfirmation(null)
                  const opener = actionButton.current ?? input.current
                  opener?.focus()
                }}
                onConfirm={() => {
                  input.current?.focus()
                  confirm(confirmation)
                }}
              />
            )}
          </article>
        ))}
      </section>
    </>
  )
}

function ChallengeRecord({
  challenge,
  disclosure,
  onDismiss,
}: {
  challenge: DnsChallenge
  disclosure: Ref<HTMLElement>
  onDismiss: () => void
}) {
  const { t, formatLocale } = useI18n()
  const title = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  return (
    <section ref={disclosure} aria-labelledby={title} className="panel panel-success">
      <h2 id={title} ref={heading} tabIndex={-1}>
        {t('DNS TXT record')}
      </h2>
      <p>
        {t(
          'Publish this TXT record in your DNS settings. The value is shown once, so copy it before dismissing this record.',
        )}
      </p>
      <dl className="details">
        <dt>{t('TXT name')}</dt>
        <dd className="stack">
          <code className="user-content">{challenge.txtName}</code>
          <CopyButton text={challenge.txtName} label={t('Copy TXT name')} />
        </dd>
        <dt>{t('TXT value')}</dt>
        <dd className="stack">
          <code className="user-content" data-private>
            {challenge.txtValue}
          </code>
          <CopyButton text={challenge.txtValue} label={t('Copy TXT value')} />
        </dd>
      </dl>
      <p>
        {t('Challenge expires at {time}.', {
          time: zoned(browserTimeZone(), formatLocale).dateTime(challenge.expiresAt),
        })}
      </p>
      <button type="button" className="button" onClick={onDismiss}>
        {t('Dismiss')}
      </button>
    </section>
  )
}

function DomainConfirmation({
  action,
  onCancel,
  onConfirm,
}: {
  action: DomainAction
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const title = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  const rotate = action.kind === 'rotate'

  return (
    // biome-ignore lint/a11y/useSemanticElements: group the inline confirmation's buttons without a form.
    <div
      className="confirm"
      role="group"
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <p id={title}>
        <strong>{t(rotate ? 'Rotate DNS challenge?' : 'Retire domain?')}</strong>
      </p>
      <p className="user-content">
        {t(
          rotate
            ? 'Generate a new TXT value for {domain} and reset its verification?'
            : 'Retiring {domain} ends its use for single sign-on.',
          { domain: action.domain.name },
        )}
      </p>
      <div className="confirm-buttons">
        <button className="button button-small button-danger" type="button" onClick={onConfirm}>
          {t(rotate ? 'Rotate challenge' : 'Retire domain')}
        </button>
        <button className="button button-small" type="button" ref={cancel} onClick={onCancel}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  )
}
