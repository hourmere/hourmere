import { isPublicTeamSlug, isReservedName } from '@hourmere/core/reserved'
import { type FormEvent, useState } from 'react'
import { type TeamDetails, updateTeamDetails } from '../api/auth.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { describedBy, ErrorSummary, Field, type FieldErrors } from '../components/forms.tsx'
import { OrganizationContextConflict } from '../components/OrganizationContextConflict.tsx'
import { useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { TEAM_LINK_SLUG_HINT } from '../paths.ts'
import { useSession } from '../session.tsx'
import { useUnsavedChanges } from '../unsaved-changes.tsx'

const labels = { teamName: 'Team name', teamSlug: 'Team public address' } as const
const reserved = 'This team address is reserved. Choose another one.'

export function TeamDetailsSettings({
  organization,
}: {
  organization: TeamDetails & { id: string }
}) {
  const { t } = useI18n()
  const { refresh, confirmReload } = useSession()
  const mounted = useMounted()
  // Keep the original values through background session refreshes while this form is open.
  const [baseline, setBaseline] = useState<TeamDetails>(organization)
  const [draft, setDraft] = useState(baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<UiText | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState<RequestError | null>(null)
  const teamChanged = conflict?.code === 'TEAM_SETTINGS_CHANGED'
  const name = draft.name === baseline.name ? baseline.name : draft.name.trim()
  const slug = draft.slug === baseline.slug ? baseline.slug : draft.slug.trim()
  const nameChanged = name !== baseline.name
  const slugChanged = slug !== baseline.slug
  const dirty = nameChanged || slugChanged
  useUnsavedChanges(dirty)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dirty || saving || conflict) return
    setAttempt((value) => value + 1)
    setError(null)
    setSaved(false)
    const problems: FieldErrors = {}
    if (
      nameChanged &&
      (!name || name.length > 200 || !name.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name))
    ) {
      problems.teamName = 'Enter a team name on one line, up to 200 characters.'
    }
    if (slugChanged && !isPublicTeamSlug(slug)) {
      problems.teamSlug = isReservedName(slug) ? reserved : TEAM_LINK_SLUG_HINT
    }
    setErrors(problems)
    if (Object.keys(problems).length) return
    setSaving(true)
    try {
      const updated = await updateTeamDetails(organization.id, baseline, {
        ...(nameChanged && { name }),
        ...(slugChanged && { slug }),
      })
      if (!mounted.current) return
      setBaseline(updated)
      setDraft(updated)
      setSaved(true)
      void refresh({ fresh: true })
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof RequestError) {
        if (isOrganizationContextChanged(cause) || cause.code === 'TEAM_SETTINGS_CHANGED') {
          setConflict(cause)
          return
        }
        if (cause.code === 'ORGANIZATION_SLUG_ALREADY_TAKEN') {
          setErrors({ teamSlug: 'This team address is already in use. Choose another one.' })
          return
        }
        if (cause.code === 'ORGANIZATION_SLUG_RESERVED') {
          setErrors({ teamSlug: reserved })
          return
        }
      }
      setError(errorMessage(cause))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="team-details-heading">
      <h2 id="team-details-heading">{t('Team details')}</h2>
      {teamChanged ? (
        <div className="alert alert-error" role="alert">
          <p>
            {t(
              'Team details changed since you opened this page. Reload team details before saving again.',
            )}
          </p>
          <button type="button" className="button button-small" onClick={confirmReload}>
            {t('Reload team details')}
          </button>
        </div>
      ) : (
        <OrganizationContextConflict error={conflict} />
      )}
      <form className="stack" onSubmit={submit} noValidate aria-labelledby="team-details-heading">
        <ErrorSummary errors={errors} labels={labels} message={error} attempt={attempt} />
        <fieldset className="form-fieldset stack" disabled={saving} role="presentation">
          <Field
            id="teamName"
            label={t(labels.teamName)}
            hint={t('Use a name your teammates will recognize, up to 200 characters.')}
            error={errors.teamName}
          >
            {(props) => (
              <input
                {...props}
                autoComplete="organization"
                value={draft.name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value })
                  setSaved(false)
                }}
              />
            )}
          </Field>
          <Field
            id="teamSlug"
            label={t(labels.teamSlug)}
            hint={t(TEAM_LINK_SLUG_HINT)}
            error={errors.teamSlug}
          >
            {(props) => (
              <input
                {...props}
                aria-describedby={describedBy(
                  props['aria-describedby'],
                  slugChanged && 'team-address-impact',
                )}
                className="mono"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={draft.slug}
                onChange={(event) => {
                  setDraft({ ...draft, slug: event.target.value })
                  setSaved(false)
                }}
              />
            )}
          </Field>
        </fieldset>
        <div aria-live="polite">
          {slugChanged && (
            <p className="alert" id="team-address-impact">
              {t(
                'Changing the public address changes this team’s public booking links. Links using the old address will no longer reach this team. Replace shared links and embeds after saving.',
              )}
            </p>
          )}
        </div>
        <div className="form-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={!dirty || saving || Boolean(conflict)}
          >
            {saving ? t('Saving…') : t('Save team details')}
          </button>
          <p className="form-status" role="status">
            {saved ? t('Team details saved.') : dirty && t('Unsaved changes')}
          </p>
        </div>
      </form>
    </section>
  )
}
