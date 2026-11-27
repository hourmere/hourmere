import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api/client.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { SsoLinkRetirement } from './SsoLinkRetirement.tsx'
import {
  type SsoDomain,
  type SsoMutation,
  type SsoProvider,
  ssoAuthorizationUrl,
  unwrapSsoWrite,
} from './setup.ts'

interface ProviderProps {
  organizationId: string
  domains: SsoDomain[]
  busy: boolean
  mutate: SsoMutation
  reload: () => void
}

export type ProviderProtocol = 'oidc' | 'saml'
export type ProviderEditor = { protocol: ProviderProtocol; provider: SsoProvider | null }

const endpointFields = [
  ['authorizationEndpoint', 'Authorization endpoint'],
  ['tokenEndpoint', 'Token endpoint'],
  ['jwksUrl', 'JWKS URL'],
] as const

export function SsoProviderSetup({
  providers,
  owner,
  addsTrust = true,
  samlEnabled = false,
  ...props
}: ProviderProps & {
  providers: SsoProvider[]
  owner: boolean
  addsTrust?: boolean
  samlEnabled?: boolean
}) {
  const { t } = useI18n()
  const heading = useId()
  const [editor, setEditor] = useState<ProviderEditor | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const visibleProviders = providers.filter(
    ({ protocol }) => protocol === 'oidc' || protocol === 'saml',
  )
  const editing = (editor?.protocol === 'saml' ? samlEnabled : addsTrust) ? editor : null

  useEffect(() => {
    if (!editing) {
      setEditor(null)
      opener.current?.focus()
      opener.current = null
    }
  }, [editing])

  return (
    <section className="sso-providers" aria-labelledby={heading}>
      <h2 id={heading}>{t('Identity providers')}</h2>
      {(addsTrust || samlEnabled) && (
        <div className="form-actions">
          {addsTrust && (
            <button
              type="button"
              className="button button-primary"
              disabled={props.busy || editing !== null}
              onClick={(event) => {
                opener.current = event.currentTarget
                setEditor({ protocol: 'oidc', provider: null })
              }}
            >
              {t('Add provider')}
            </button>
          )}
          {samlEnabled && (
            <button
              type="button"
              className="button button-primary"
              disabled={props.busy || editing !== null}
              onClick={(event) => {
                opener.current = event.currentTarget
                setEditor({ protocol: 'saml', provider: null })
              }}
            >
              {t('Add SAML provider')}
            </button>
          )}
        </div>
      )}
      {editing && <ProviderForm {...props} {...editing} onClose={() => setEditor(null)} />}
      {visibleProviders.length === 0 && !editing && (
        <p className="empty">{t('No identity providers yet.')}</p>
      )}
      {visibleProviders.map((provider) => {
        const protocol = provider.protocol === 'saml' ? 'saml' : 'oidc'
        const canEdit = protocol === 'saml' ? samlEnabled : addsTrust
        return (
          <section
            key={provider.id}
            className="panel"
            aria-labelledby={`${heading}-${provider.id}`}
          >
            <h3 id={`${heading}-${provider.id}`} className="user-content">
              {provider.displayName}
            </h3>
            <p className="user-content">{provider.issuer}</p>
            <p>
              {t('Revision {revision}', { revision: provider.revision })} ·{' '}
              {t(provider.enabled ? 'Enabled' : 'Disabled')}
            </p>
            <ProviderActivation
              {...props}
              busy={props.busy || editing !== null}
              provider={provider}
              owner={owner}
              addsTrust={canEdit}
              samlEnabled={samlEnabled}
            />
            <fieldset className="form-fieldset" disabled={props.busy || editing !== null}>
              <div className="form-actions">
                {protocol === 'saml' && canEdit && (
                  <SamlMetadataDownload providerId={provider.id} />
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="button button-small"
                    aria-label={t('Edit {name}', { name: provider.displayName })}
                    onClick={(event) => {
                      opener.current = event.currentTarget
                      setEditor({ protocol, provider })
                    }}
                  >
                    {t('Edit')}
                  </button>
                )}
                <ConfirmAction
                  label="Retire provider"
                  accessibleLabel={t('Retire provider {name}', { name: provider.displayName })}
                  prompt="Retire this provider? This action is permanent."
                  confirmLabel="Retire provider"
                  busyLabel="Retiring provider…"
                  failure="Could not save SSO settings."
                  onConfirm={() =>
                    props.mutate(
                      (signal, proofAttemptId) =>
                        unwrapSsoWrite(
                          api.DELETE('/api/v1/team/sso/providers/{providerId}', {
                            signal,
                            params: {
                              path: { providerId: provider.id },
                              header: { 'X-Expected-Organization-Id': props.organizationId },
                            },
                            body: { expectedRevision: provider.revision, proofAttemptId },
                          }),
                        ),
                      props.reload,
                    )
                  }
                />
              </div>
            </fieldset>
            <SsoLinkRetirement
              provider={provider}
              organizationId={props.organizationId}
              busy={props.busy || editing !== null}
              mutate={props.mutate}
            />
          </section>
        )
      })}
    </section>
  )
}

export function SamlMetadataDownload({ providerId }: { providerId: string }) {
  const { t } = useI18n()
  return (
    <a
      className="button button-small"
      href={'/api/auth/sso/saml2/sp/metadata/:providerId'.replace(
        ':providerId',
        encodeURIComponent(providerId),
      )}
      download
    >
      {t('Download service provider metadata')}
    </a>
  )
}

const activationErrors = {
  sso_test_required: 'Pass a test of this provider’s current revision before enabling it.',
  sso_domain_unverified: 'Verify an associated domain before enabling this provider.',
  sso_last_provider: 'Enable another usable OIDC provider before disabling this provider.',
} as const satisfies Record<string, MessageKey>

function ProviderActivation({
  provider,
  organizationId,
  busy,
  mutate,
  reload,
  owner,
  addsTrust,
  samlEnabled,
}: Pick<ProviderProps, 'organizationId' | 'busy' | 'mutate' | 'reload'> & {
  provider: SsoProvider
  owner: boolean
  addsTrust: boolean
  samlEnabled: boolean
}) {
  const { t } = useI18n()
  const [testUrl, setTestUrl] = useState<string | null>(null)
  const testLink = useRef<HTMLAnchorElement>(null)
  const statusId = useId()
  const canEnable =
    provider.testStatus === 'passed' && provider.domains.some(({ status }) => status === 'verified')
  const domainCheckUnknown = provider.domains.some(
    ({ status }) => !['pending', 'verified', 'failed', 'expired'].includes(status),
  )
  const enabling = !provider.enabled
  const params = {
    path: { providerId: provider.id },
    header: { 'X-Expected-Organization-Id': organizationId },
  }

  useEffect(() => {
    if (testUrl) testLink.current?.focus()
  }, [testUrl])

  function startTest() {
    setTestUrl(null)
    void mutate(async (signal, proofAttemptId) => {
      const { url } = await unwrapSsoWrite(
        api.POST('/api/v1/team/sso/providers/{providerId}/test', {
          params,
          body: { expectedRevision: provider.revision, proofAttemptId },
          signal,
        }),
      )
      return ssoAuthorizationUrl(url)
    }, setTestUrl)
  }

  function changeActivation() {
    return mutate(
      (signal, proofAttemptId) =>
        unwrapSsoWrite(
          api.POST('/api/v1/team/sso/providers/{providerId}/activation', {
            params,
            body: { expectedRevision: provider.revision, enabled: enabling, proofAttemptId },
            signal,
          }),
        ),
      reload,
      samlEnabled || provider.protocol === 'saml'
        ? {
            ...activationErrors,
            sso_last_provider: 'Enable another usable provider before disabling this provider.',
          }
        : activationErrors,
    )
  }

  return (
    <div>
      <p id={statusId}>
        {t(
          provider.testStatus === 'passed'
            ? 'Current revision passed its test.'
            : provider.testStatus === 'failed'
              ? 'Current revision failed its test.'
              : provider.protocol !== 'saml' || provider.testStatus === 'not_tested'
                ? 'No test result for the current revision.'
                : 'Provider test status is unavailable.',
        )}
        {owner && enabling && provider.testStatus === 'passed' && !canEnable && (
          <>
            {' '}
            {t(
              domainCheckUnknown ? 'Verification unknown' : activationErrors.sso_domain_unverified,
            )}
          </>
        )}
      </p>
      {/* Testing and enabling add trust; with the setting off only disabling remains. */}
      {(addsTrust || !enabling) && (
        <fieldset className="form-fieldset" disabled={busy}>
          <div className="form-actions">
            {enabling && (
              <>
                <button
                  type="button"
                  className="button button-small"
                  aria-label={t('Test provider {name}', { name: provider.displayName })}
                  onClick={startTest}
                >
                  {t('Test provider')}
                </button>
                {testUrl && !busy && (
                  <a
                    ref={testLink}
                    className="button button-small"
                    href={testUrl}
                    rel="noreferrer"
                    data-private
                  >
                    {t('Continue to identity provider')}
                  </a>
                )}
              </>
            )}
            {owner &&
              (enabling && !canEnable ? (
                <button
                  type="button"
                  className="button button-small"
                  aria-label={t('Enable provider {name}', { name: provider.displayName })}
                  aria-describedby={statusId}
                  disabled
                >
                  {t('Enable provider')}
                </button>
              ) : (
                <ConfirmAction
                  label={enabling ? 'Enable provider' : 'Disable provider'}
                  accessibleLabel={t(
                    enabling ? 'Enable provider {name}' : 'Disable provider {name}',
                    {
                      name: provider.displayName,
                    },
                  )}
                  prompt={enabling ? 'Enable this provider?' : 'Disable this provider?'}
                  confirmLabel={enabling ? 'Enable provider' : 'Disable provider'}
                  busyLabel={enabling ? 'Enabling provider…' : 'Disabling provider…'}
                  failure="Could not save SSO settings."
                  onConfirm={changeActivation}
                />
              ))}
          </div>
        </fieldset>
      )}
    </div>
  )
}

export function ProviderForm({
  organizationId,
  domains,
  busy,
  mutate,
  reload,
  provider,
  protocol = provider?.protocol === 'saml' ? 'saml' : 'oidc',
  recovering = false,
  onClose,
}: ProviderProps & {
  provider: SsoProvider | null
  protocol?: ProviderProtocol
  recovering?: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const formId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [replaceSecret, setReplaceSecret] = useState(false)
  const initialDomainIds = new Set(provider?.domains.map(({ id }) => id))
  const availableDomains = domains.filter(({ status }) => status !== 'retired')
  const header = { 'X-Expected-Organization-Id': organizationId }

  useEffect(() => heading.current?.focus(), [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const fields = new FormData(form)
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
    const signingCertificates = fields
      .getAll('signingCertificates')
      .map((certificate) => String(certificate).trim())
      .filter(Boolean)
    const saml = {
      ...Object.fromEntries(
        ['entityId', 'ssoUrl', 'metadataDocument', 'metadataUrl', 'subjectAttribute']
          .map((name) => [name, value(name).trim()])
          .filter(([, input]) => input),
      ),
      ...(signingCertificates.length > 0 && { signingCertificates }),
    }
    // Keep write-only values out of the editor while a proof or response is pending.
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '[data-private]',
    )) {
      input.value = ''
    }
    const samlErrors =
      protocol === 'saml'
        ? ({
            invalid_request:
              'Check the SAML metadata, sign-in URL and signing certificates, then try again.',
          } as const)
        : undefined
    const saved = () => {
      onClose()
      reload()
    }
    if (provider) {
      const oidc = { ...overrides, ...(replaceSecret && { clientSecret }) }
      await mutate(
        (signal, proofAttemptId) =>
          unwrapSsoWrite(
            api.PATCH('/api/v1/team/sso/providers/{providerId}', {
              signal,
              params: { path: { providerId: provider.id }, header },
              body: {
                displayName,
                expectedRevision: provider.revision,
                proofAttemptId,
                ...(domainsChanged && { domainIds }),
                ...(protocol === 'oidc' && Object.keys(oidc).length > 0 && { oidc }),
                ...(protocol === 'saml' && Object.keys(saml).length > 0 && { saml }),
              },
            }),
          ),
        saved,
        samlErrors,
      )
    } else {
      await mutate(
        (signal, proofAttemptId) =>
          unwrapSsoWrite(
            api.POST('/api/v1/team/sso/providers', {
              signal,
              params: { header },
              body: {
                displayName,
                domainIds,
                protocol,
                proofAttemptId,
                ...(protocol === 'saml'
                  ? { saml: { ...saml, wantAssertionsSigned: true } }
                  : {
                      oidc: {
                        ...overrides,
                        issuer: value('issuer').trim(),
                        clientId: value('clientId'),
                        clientSecret,
                      },
                    }),
              },
            }),
          ),
        saved,
        samlErrors,
      )
    }
  }

  return (
    <form className="panel editor" aria-labelledby={formId} onSubmit={submit}>
      <h3 id={formId} ref={heading} tabIndex={-1}>
        {t(
          provider
            ? 'Edit provider'
            : protocol === 'saml'
              ? 'Add SAML provider'
              : 'Add OIDC provider',
        )}
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
          {protocol === 'oidc' && (
            <>
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
            </>
          )}
        </div>
        {protocol === 'saml' ? (
          <SamlProviderFields formId={formId} provider={provider} recovering={recovering} />
        ) : (
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
        )}
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

function SamlProviderFields({
  formId,
  provider,
  recovering,
}: {
  formId: string
  provider: SsoProvider | null
  recovering: boolean
}) {
  const { t } = useI18n()
  const [source, setSource] = useState('manual')
  const [certificateCount, setCertificateCount] = useState(1)
  const manual = source === 'manual'
  const privateInput = {
    autoComplete: 'off',
    autoCapitalize: 'none',
    spellCheck: false,
    'data-private': true,
  }

  return (
    <>
      <p className="hint">{t('Signed assertions are required.')}</p>
      {provider && (
        <p className="hint">
          {t('Leave blank to keep saved settings. Import metadata again to replace its settings.')}
        </p>
      )}
      <Field id={`${formId}-saml-source`} label={t('SAML configuration source')}>
        {(control) => (
          <select {...control} value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="manual">{t('Enter configuration manually')}</option>
            <option value="xml">{t('Paste identity provider metadata')}</option>
            <option value="url">{t('Import metadata from a URL')}</option>
          </select>
        )}
      </Field>
      <div className="field-grid">
        {(provider || manual) && (
          <Field id={`${formId}-entity-id`} label={t('Identity provider entity ID')}>
            {(control) => (
              <input
                {...control}
                name={provider ? undefined : 'entityId'}
                defaultValue={provider?.issuer}
                readOnly={!!provider}
                required={!provider}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={2048}
              />
            )}
          </Field>
        )}
        {manual && (
          <Field id={`${formId}-redirect-url`} label={t('HTTP-Redirect sign-in URL')}>
            {(control) => (
              <input
                {...control}
                {...privateInput}
                name="ssoUrl"
                type="url"
                required={!provider}
                maxLength={2048}
              />
            )}
          </Field>
        )}
        {!provider && (
          <Field
            id={`${formId}-subject-attribute`}
            label={t('Subject attribute')}
            hint={t('Leave blank to use the persistent NameID.')}
            optional
          >
            {(control) => (
              <input {...control} {...privateInput} name="subjectAttribute" maxLength={512} />
            )}
          </Field>
        )}
      </div>
      {source === 'xml' && (
        <Field id={`${formId}-metadata-xml`} label={t('Identity provider metadata XML')}>
          {(control) => (
            <textarea
              {...control}
              {...privateInput}
              name="metadataDocument"
              required
              maxLength={262144}
            />
          )}
        </Field>
      )}
      {source === 'url' && (
        <Field id={`${formId}-metadata-url`} label={t('Identity provider metadata URL')}>
          {(control) => (
            <input
              {...control}
              {...privateInput}
              name="metadataUrl"
              type="url"
              required
              maxLength={2048}
            />
          )}
        </Field>
      )}
      <fieldset className="form-fieldset stack">
        <legend>{t('Signing certificates')}</legend>
        {provider && (
          <p className="hint">
            {t(
              recovering
                ? 'If you are replacing signing certificates, enter the full set your identity provider uses.'
                : 'To test a rotation, use a disabled draft. Submit the full set with both old and new certificates, test the new revision, then remove the old certificate after the identity provider switches.',
            )}
          </p>
        )}
        {!manual && (
          <p className="hint">{t('Supply signing certificates if the metadata contains none.')}</p>
        )}
        {[1, 2, 3, 4].slice(0, certificateCount).map((number) => (
          <Field
            key={number}
            id={`${formId}-certificate-${number}`}
            label={t('Signing certificate {number}', { number })}
          >
            {(control) => (
              <textarea
                {...control}
                {...privateInput}
                name="signingCertificates"
                required={!provider && manual && number === 1}
                maxLength={16384}
              />
            )}
          </Field>
        ))}
        {certificateCount < 4 && (
          <div className="form-actions">
            <button
              type="button"
              className="button button-small"
              onClick={() => setCertificateCount(certificateCount + 1)}
            >
              {t('Add signing certificate')}
            </button>
          </div>
        )}
      </fieldset>
    </>
  )
}
