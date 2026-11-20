import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { SsoDomain, SsoMutation, SsoProvider } from './setup.ts'

interface ProviderProps {
  organizationId: string
  domains: SsoDomain[]
  busy: boolean
  mutate: SsoMutation
  reload: () => void
}

const endpointFields = [
  ['authorizationEndpoint', 'Authorization endpoint'],
  ['tokenEndpoint', 'Token endpoint'],
  ['jwksUrl', 'JWKS URL'],
] as const

export function SsoProviderSetup({
  providers,
  ...props
}: ProviderProps & { providers: SsoProvider[] }) {
  const { t } = useI18n()
  const heading = useId()
  const [editing, setEditing] = useState<'new' | SsoProvider | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const oidcProviders = providers.filter((provider) => provider.protocol === 'oidc')

  useEffect(() => {
    if (!editing && opener.current) {
      opener.current.focus()
      opener.current = null
    }
  }, [editing])

  return (
    <section className="sso-providers" aria-labelledby={heading}>
      <h2 id={heading}>{t('Identity providers')}</h2>
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={props.busy || editing !== null}
          onClick={(event) => {
            opener.current = event.currentTarget
            setEditing('new')
          }}
        >
          {t('Add provider')}
        </button>
      </div>
      {editing && (
        <ProviderForm
          {...props}
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {oidcProviders.length === 0 && !editing && (
        <p className="empty">{t('No identity providers yet.')}</p>
      )}
      {oidcProviders.map((provider) => (
        <section key={provider.id} className="panel" aria-labelledby={`${heading}-${provider.id}`}>
          <h3 id={`${heading}-${provider.id}`} className="user-content">
            {provider.displayName}
          </h3>
          <p className="user-content">{provider.issuer}</p>
          <p>
            {t('Revision {revision}', { revision: provider.revision })} ·{' '}
            {t(provider.enabled ? 'Enabled' : 'Disabled')}
          </p>
          <fieldset className="form-fieldset" disabled={props.busy || editing !== null}>
            <div className="form-actions">
              <button
                type="button"
                className="button button-small"
                aria-label={t('Edit {name}', { name: provider.displayName })}
                onClick={(event) => {
                  opener.current = event.currentTarget
                  setEditing(provider)
                }}
              >
                {t('Edit')}
              </button>
              <ConfirmAction
                label="Retire provider"
                accessibleLabel={t('Retire provider {name}', { name: provider.displayName })}
                prompt="Retire this provider? This action is permanent."
                confirmLabel="Retire provider"
                busyLabel="Retiring provider…"
                failure="Could not save SSO settings."
                onConfirm={() =>
                  props.mutate(
                    (signal) =>
                      unwrap(
                        api.DELETE('/api/v1/team/sso/providers/{providerId}', {
                          signal,
                          params: {
                            path: { providerId: provider.id },
                            header: { 'X-Expected-Organization-Id': props.organizationId },
                          },
                          body: { expectedRevision: provider.revision },
                        }),
                      ),
                    props.reload,
                  )
                }
              />
            </div>
          </fieldset>
        </section>
      ))}
    </section>
  )
}

function ProviderForm({
  organizationId,
  domains,
  busy,
  mutate,
  reload,
  provider,
  onClose,
}: ProviderProps & { provider: SsoProvider | null; onClose: () => void }) {
  const { t } = useI18n()
  const formId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const secretInput = useRef<HTMLInputElement>(null)
  const [replaceSecret, setReplaceSecret] = useState(false)
  const initialDomainIds = new Set(provider?.domains.map(({ id }) => id))
  const availableDomains = domains.filter(({ status }) => status !== 'retired')
  const header = { 'X-Expected-Organization-Id': organizationId }

  useEffect(() => heading.current?.focus(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    const value = (name: string) => String(fields.get(name) ?? '')
    const domainIds = fields.getAll('domainIds').map(String)
    const domainsChanged = availableDomains.some(
      ({ id }) => initialDomainIds.has(id) !== domainIds.includes(id),
    )
    const displayName = value('displayName').trim()
    const clientSecret = value('clientSecret')
    const overrides = Object.fromEntries(
      endpointFields.map(([name]) => [name, value(name).trim()]).filter(([, url]) => url),
    )
    if (secretInput.current) secretInput.current.value = ''
    const saved = () => {
      onClose()
      reload()
    }
    if (provider) {
      const oidc = { ...overrides, ...(replaceSecret && { clientSecret }) }
      await mutate(
        (signal) =>
          unwrap(
            api.PATCH('/api/v1/team/sso/providers/{providerId}', {
              signal,
              params: { path: { providerId: provider.id }, header },
              body: {
                displayName,
                expectedRevision: provider.revision,
                ...(domainsChanged && { domainIds }),
                ...(Object.keys(oidc).length > 0 && { oidc }),
              },
            }),
          ),
        saved,
      )
    } else {
      await mutate(
        (signal) =>
          unwrap(
            api.POST('/api/v1/team/sso/providers', {
              signal,
              params: { header },
              body: {
                displayName,
                domainIds,
                protocol: 'oidc',
                oidc: {
                  ...overrides,
                  issuer: value('issuer').trim(),
                  clientId: value('clientId'),
                  clientSecret,
                },
              },
            }),
          ),
        saved,
      )
    }
  }

  return (
    <form className="panel editor" aria-labelledby={formId} onSubmit={submit}>
      <h3 id={formId} ref={heading} tabIndex={-1}>
        {t(provider ? 'Edit provider' : 'Add OIDC provider')}
      </h3>
      <fieldset className="form-fieldset stack" disabled={busy}>
        <div className="field-grid">
          <Field id={`${formId}-display`} label={t('Display name')}>
            {(control) => (
              <input
                {...control}
                name="displayName"
                defaultValue={provider?.displayName}
                required
                maxLength={100}
              />
            )}
          </Field>
          <Field id={`${formId}-issuer`} label={t('Issuer URL')}>
            {(control) => (
              <input
                {...control}
                name="issuer"
                type="url"
                defaultValue={provider?.issuer}
                readOnly={!!provider}
                required
                maxLength={2048}
              />
            )}
          </Field>
          <Field id={`${formId}-client-id`} label={t('Client ID')}>
            {(control) => (
              <input
                {...control}
                name="clientId"
                defaultValue={provider?.clientId ?? ''}
                readOnly={!!provider}
                spellCheck={false}
                autoCapitalize="none"
                required
                maxLength={1024}
              />
            )}
          </Field>
          {provider && (
            <div className="field">
              <button
                type="button"
                className="button"
                aria-controls={`${formId}-replace`}
                aria-expanded={replaceSecret}
                onClick={() => setReplaceSecret(!replaceSecret)}
              >
                {t(replaceSecret ? 'Keep current secret' : 'Replace client secret')}
              </button>
            </div>
          )}
          <div id={`${formId}-replace`} hidden={!!provider && !replaceSecret}>
            {(!provider || replaceSecret) && (
              <Field
                id={`${formId}-secret`}
                label={t(provider ? 'New client secret' : 'Client secret')}
              >
                {(control) => (
                  <input
                    {...control}
                    ref={secretInput}
                    name="clientSecret"
                    type="password"
                    autoComplete="new-password"
                    data-private
                    required
                    maxLength={16384}
                  />
                )}
              </Field>
            )}
          </div>
        </div>
        <fieldset className="form-fieldset">
          <legend>{t('Endpoint overrides')}</legend>
          {provider && (
            <p className="hint">{t('Leave URLs blank to keep the current settings.')}</p>
          )}
          <div className="field-grid">
            {endpointFields.map(([name, label]) => (
              <Field key={name} id={`${formId}-${name}`} label={t(label)} optional>
                {(control) => <input {...control} name={name} type="url" maxLength={2048} />}
              </Field>
            ))}
          </div>
        </fieldset>
        {availableDomains.length > 0 && (
          <fieldset className="form-fieldset">
            <legend>{t('Associated domains')}</legend>
            {availableDomains.map(({ id, name }) => (
              <label key={id} className="checkbox user-content">
                <input
                  type="checkbox"
                  name="domainIds"
                  value={id}
                  defaultChecked={initialDomainIds.has(id)}
                />
                {name}
              </label>
            ))}
          </fieldset>
        )}
        <div className="form-actions">
          <button type="submit" className="button button-primary">
            {t(busy ? 'Saving…' : 'Save changes')}
          </button>
          <button type="button" className="button" onClick={onClose}>
            {t('Cancel')}
          </button>
        </div>
      </fieldset>
    </form>
  )
}
