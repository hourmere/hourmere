import { type SsoRequest, sendSsoRequest, ssoUrl } from '@hourmere/outbound/sso'
import { DomainError } from '@hourmere/scheduling'
import { z } from 'zod'
import { type samlProviderConfig, samlServiceProviderUrls } from './sso-saml-state.ts'
import {
  parseSamlXml,
  samlMaximumResponseBytes,
  samlMaximumSigningCertificates,
  samlSigningCertificate,
} from './sso-saml-verifier.ts'

const metadataNamespace = 'urn:oasis:names:tc:SAML:2.0:metadata'
const protocolNamespace = 'urn:oasis:names:tc:SAML:2.0:protocol'
const signatureNamespace = 'http://www.w3.org/2000/09/xmldsig#'
const redirectBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
const postBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const reservedRedirectParameters = new Set([
  'samlrequest',
  'samlresponse',
  'logoutrequest',
  'logoutresponse',
  'sigalg',
  'signature',
  'relaystate',
  'samlencoding',
])

const entityIdInput = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.isWellFormed() && !/[\s\p{Cc}]/u.test(value))
const urlInput = z.url().max(2048)
const certificateInput = z.string().min(1).max(16_384)
// A maximal inline document and four certificate strings can be sent as JSON Unicode escapes.
export const samlProviderRequestMaximumBytes = 2 * 1024 * 1024

/** PATCH may omit pinned values. CREATE and imports must resolve to a complete configuration. */
export const samlProviderInput = z
  .strictObject({
    entityId: entityIdInput.optional(),
    ssoUrl: urlInput.optional(),
    signingCertificates: z
      .array(certificateInput)
      .min(1)
      .max(samlMaximumSigningCertificates)
      .meta({ writeOnly: true })
      .optional(),
    metadataUrl: urlInput.meta({ writeOnly: true }).optional(),
    metadataDocument: z
      .string()
      .min(1)
      .max(samlMaximumResponseBytes)
      .meta({ writeOnly: true })
      .optional(),
    wantAssertionsSigned: z.literal(true).optional(),
  })
  .refine(({ metadataUrl, metadataDocument }) => !metadataUrl || !metadataDocument)

const invalid = () => new DomainError('invalid', 'invalid_request')

export function samlIdentityProviderRedirectUrl(
  value: unknown,
  privateTargets: SsoRequest['privateTargets'],
): string | undefined {
  const normalized = ssoUrl(value, privateTargets)
  if (!normalized) return undefined
  const url = new URL(normalized)
  for (const key of url.searchParams.keys())
    if (reservedRedirectParameters.has(key.toLowerCase())) return undefined
  if (!url.search) url.search = ''
  return url.href
}

type XmlElement = ReturnType<typeof parseSamlXml>
const isElement = (element: XmlElement, namespace: string, name: string) =>
  element.namespaceURI === namespace && element.localName === name
const children = (parent: XmlElement, namespace: string, name: string) =>
  Array.from(parent.childNodes).filter(
    (child): child is XmlElement =>
      child.nodeType === 1 && isElement(child as XmlElement, namespace, name),
  )

export function normalizeSamlSigningCertificates(values: readonly string[]) {
  if (values.length > samlMaximumSigningCertificates) throw invalid()
  const certificates = values.map((value) => {
    const input = certificateInput.parse(value).trim()
    const pem =
      /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/.exec(
        input,
      )
    const base64 = (pem?.[1] ?? input).replace(/[\t\r\n ]/g, '')
    const parsed = samlSigningCertificate(base64).raw.toString('base64')
    if (parsed !== base64) throw invalid()
    return parsed
  })
  return [...new Set(certificates)].sort()
}

function parseIdpMetadata(document: string) {
  const root = parseSamlXml(document)
  if (!isElement(root, metadataNamespace, 'EntityDescriptor')) throw invalid()
  const entityId = entityIdInput.parse(root.getAttribute('entityID'))
  const descriptors = children(root, metadataNamespace, 'IDPSSODescriptor').filter((node) =>
    node.getAttribute('protocolSupportEnumeration')?.split(/\s+/).includes(protocolNamespace),
  )
  const [descriptor] = descriptors
  if (!descriptor || descriptors.length !== 1) throw invalid()
  const redirects = children(descriptor, metadataNamespace, 'SingleSignOnService').filter(
    (node) => node.getAttribute('Binding') === redirectBinding,
  )
  const [redirect] = redirects
  if (!redirect || redirects.length !== 1) throw invalid()

  const certificates = children(descriptor, metadataNamespace, 'KeyDescriptor')
    .filter((node) => !node.hasAttribute('use') || node.getAttribute('use') === 'signing')
    .flatMap((node) => children(node, signatureNamespace, 'KeyInfo'))
    .flatMap((node) => children(node, signatureNamespace, 'X509Data'))
    .flatMap((node) => children(node, signatureNamespace, 'X509Certificate'))
    .map((node) => {
      const parts = Array.from(node.childNodes)
      if (parts.some((part) => part.nodeType !== 3)) throw invalid()
      return parts.map((part) => part.nodeValue ?? '').join('')
    })

  return { entityId, ssoUrl: redirect.getAttribute('Location'), certificates }
}

async function downloadMetadata(
  url: string,
  privateTargets: SsoRequest['privateTargets'],
  transport: typeof sendSsoRequest,
) {
  const normalized = ssoUrl(url, privateTargets)
  if (!normalized) throw invalid()
  const response = await transport({
    url: normalized,
    method: 'GET',
    headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
    privateTargets,
  })
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.body.length > samlMaximumResponseBytes
  )
    throw invalid()
  return new TextDecoder('utf-8', { fatal: true }).decode(response.body)
}

interface SamlInputOptions {
  current?: { entityId: string; configuration: z.infer<typeof samlProviderConfig> } | undefined
  privateTargets?: SsoRequest['privateTargets'] | undefined
  transport?: typeof sendSsoRequest | undefined
}

/** Imports are explicit, and neither their source nor their XML is kept in the sealed configuration. */
export async function resolveSamlProviderInput(
  input: z.infer<typeof samlProviderInput>,
  { current, privateTargets = [], transport = sendSsoRequest }: SamlInputOptions = {},
) {
  try {
    const pinned = current?.entityId ?? input.entityId
    if (input.entityId !== undefined && input.entityId !== pinned) throw invalid()
    const xml = input.metadataUrl
      ? await downloadMetadata(input.metadataUrl, privateTargets, transport)
      : input.metadataDocument
    const imported = xml === undefined ? undefined : parseIdpMetadata(xml)
    const entityId = pinned ?? imported?.entityId
    if (!entityId || (imported && imported.entityId !== entityId)) throw invalid()
    const ssoEndpoint = samlIdentityProviderRedirectUrl(
      imported ? imported.ssoUrl : (input.ssoUrl ?? current?.configuration.ssoEndpoint),
      privateTargets,
    )
    if (!ssoEndpoint) throw invalid()
    if (
      imported &&
      input.ssoUrl !== undefined &&
      ssoEndpoint !== samlIdentityProviderRedirectUrl(input.ssoUrl, privateTargets)
    )
      throw invalid()

    const pins =
      input.signingCertificates && normalizeSamlSigningCertificates(input.signingCertificates)
    const importedPins = imported && normalizeSamlSigningCertificates(imported.certificates)
    if (pins && importedPins?.length && JSON.stringify(pins) !== JSON.stringify(importedPins))
      throw invalid()
    const currentPins = current?.configuration.signingCertificates
    const certificates =
      pins ??
      (imported ? importedPins : currentPins && normalizeSamlSigningCertificates(currentPins))
    if (!certificates?.length) throw invalid()
    return { entityId, configuration: { ssoEndpoint, signingCertificates: certificates } }
  } catch {
    // Neither XML parser diagnostics nor request errors can leave this service.
    throw invalid()
  }
}

const xmlAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

export function samlServiceProviderMetadata(publicUrl: string, providerId: string) {
  const { spEntityId, acsUrl } = samlServiceProviderUrls(publicUrl, providerId)
  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="${metadataNamespace}" entityID="${xmlAttribute(spEntityId)}">
  <SPSSODescriptor protocolSupportEnumeration="${protocolNamespace}" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <AssertionConsumerService Binding="${postBinding}" Location="${xmlAttribute(acsUrl)}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`
}
