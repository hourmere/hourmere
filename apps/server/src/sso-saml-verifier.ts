import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'

// SAML response verifier (docs/sso.md, "SAML"). SAML remains hard-off in production.
//
// The verifier writes no cryptography, canonicalization or XML signature code: xml-crypto
// verifies the signature and returns the canonical bytes it digested, and every value handed
// back to the caller is read from a strict parse of exactly those bytes, never from the
// submitted document. Time bounds and replay belong to the next step: timestamps are returned
// as the signed strings and are not interpreted here.
//
// Contract for the steps that will call this:
// - `assertion.*` is always authenticated. `response.*` is authenticated only when
//   `response.signed` is true; otherwise its ID, IssueInstant, Destination and Status came from
//   the unsigned wrapper. Timing uses assertion timestamps. Replay caches the response ID
//   only when signed, in addition to the request and assertion IDs.
// - InResponseTo is only checked for internal agreement (response and bearer confirmation).
//   The ACS step must compare `assertion.subjectConfirmation.inResponseTo` with the pending
//   attempt of the same provider.
// - A missing NotBefore or NotOnOrAfter is returned as null. The timing step requires both
//   Conditions bounds and the bearer expiry, and checks bearer NotBefore when present.
// - NameID and attribute values are returned exactly as signed, untrimmed. They must not be
//   trimmed, case-folded or otherwise normalised before identity matching.

const SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol'
const SAML = 'urn:oasis:names:tc:SAML:2.0:assertion'
const DSIG = 'http://www.w3.org/2000/09/xmldsig#'
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const XSI = 'http://www.w3.org/2001/XMLSchema-instance'
const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'
const ENTITY_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:entity'

/** The algorithms this verifier implements. Configuration can only narrow this set. */
const IMPLEMENTED = {
  signature: new Set(['http://www.w3.org/2001/04/xmldsig-more#rsa-sha256']),
  // Digest URI to the node:crypto hash name used to bind the consumed bytes to DigestValue.
  digest: new Map([['http://www.w3.org/2001/04/xmlenc#sha256', 'sha256']]),
  canonicalization: new Set([EXC_C14N]),
} as const

export type SamlAlgorithmAllowList = {
  signature: readonly string[]
  digest: readonly string[]
  canonicalization: readonly string[]
}

/** RSA-SHA256 over SHA-256 digests with exclusive canonicalization (docs/sso.md, "SAML"). */
export const samlInitialAlgorithms: SamlAlgorithmAllowList = {
  signature: ['http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'],
  digest: ['http://www.w3.org/2001/04/xmlenc#sha256'],
  canonicalization: [EXC_C14N],
}

export type SamlVerifierConfig = {
  /** The IdP entity ID: the only accepted Issuer. */
  idpEntityId: string
  /** This service provider's entity ID: the audience every restriction must name. */
  spEntityId: string
  /** The exact ACS URL: the only accepted Destination and bearer Recipient. */
  acsUrl: string
  /** Configured IdP signing certificates (PEM or base64 DER); the only trusted keys. */
  signingCertificates: readonly string[]
  algorithms: SamlAlgorithmAllowList
}

export type SamlRejection =
  | 'invalid_configuration'
  | 'invalid_encoding'
  | 'too_large'
  | 'forbidden_markup'
  | 'malformed_xml'
  | 'unexpected_structure'
  | 'unexpected_namespace'
  | 'duplicate_id'
  | 'multiple_assertions'
  | 'encrypted_unsupported'
  | 'assertion_signature_required'
  | 'external_reference'
  | 'signature_reference_mismatch'
  | 'algorithm_not_allowed'
  | 'signature_invalid'
  | 'verified_node_mismatch'
  | 'status_not_success'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'recipient_mismatch'
  | 'destination_mismatch'
  | 'in_response_to_mismatch'
  | 'ambiguous_attribute'

/** A refused SAML response. The reason is for logs and tests, never for the browser. */
export class SamlVerificationError extends Error {
  readonly reason: SamlRejection
  constructor(reason: SamlRejection) {
    super('SAML response rejected')
    this.name = 'SamlVerificationError'
    this.reason = reason
  }
}

const reject = (reason: SamlRejection) => new SamlVerificationError(reason)

export type VerifiedSamlResponse = {
  response: {
    id: string
    /**
     * Whether the Response element itself carried a (verified) signature. When false, the
     * other fields of `response` are unauthenticated: never use them for replay or timing.
     */
    signed: boolean
    issueInstant: string
    inResponseTo: string
    destination: string
  }
  /** Read only from the canonical bytes whose digest the IdP signature covers. */
  assertion: {
    id: string
    issueInstant: string
    issuer: string
    nameId: {
      value: string
      format: string | null
      nameQualifier: string | null
      spNameQualifier: string | null
    }
    subjectConfirmation: {
      recipient: string
      inResponseTo: string
      notBefore: string | null
      notOnOrAfter: string | null
    }
    conditions: { notBefore: string | null; notOnOrAfter: string | null }
    audiences: string[]
    authnStatements: {
      authnInstant: string
      sessionIndex: string | null
      sessionNotOnOrAfter: string | null
    }[]
    /** A null-prototype object: a name the assertion does not carry reads as undefined. */
    attributes: Record<string, string[]>
  }
}

export const samlMaximumResponseBytes = 262_144
const MAX_DEPTH = 24
const MAX_NODES = 5_000
export const samlMaximumSigningCertificates = 4
// No real response has a long run of white space; libraries need not be asked to chew on one.
const MAX_WHITESPACE_RUN = 4_096
const XML_ID = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/
const ENCRYPTED = new Set([
  'EncryptedAssertion',
  'EncryptedID',
  'EncryptedAttribute',
  'EncryptedData',
  'EncryptedKey',
])
const ELEMENT_NAMESPACES = new Set([SAMLP, SAML, DSIG, EXC_C14N])

// ---------------------------------------------------------------------------------------
// Strict parsing

// Anchored, and the only processing-instruction-like text accepted: version 1.0, UTF-8 only,
// optional standalone, either quote style.
const XML_DECLARATION =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/
// Anything outside the XML 1.0 Char production, plus the noncharacters U+FFFE and U+FFFF.
const isXmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff)

const isWhitespace = (code: number) => code === 0x20 || code === 0x9 || code === 0xa || code === 0xd

/** Refuses active markup before either XML parser sees the input. Comments are inert. */
function checkMarkup(body: string): number {
  const markup = /<!|<\?|[<>"']|&([^;&<\s]*;?)/g
  let comments = 0
  let inTag = false
  let quote: string | undefined
  for (let match = markup.exec(body); match; match = markup.exec(body)) {
    const [token, reference] = match
    if (token === '<!' || token === '<?') {
      if (inTag || !body.startsWith('<!--', match.index)) throw reject('forbidden_markup')
      // XML comments cannot contain "--" or end in a hyphen.
      const close = body.indexOf('--', match.index + 4)
      if (close < 0 || body[close + 2] !== '>') throw reject('malformed_xml')
      markup.lastIndex = close + 3
      comments += 1
      if (comments >= MAX_NODES) throw reject('too_large')
    } else if (token === '<') {
      if (inTag) throw reject('malformed_xml')
      inTag = true
    } else if (token === '>') {
      if (!quote) inTag = false
    } else if (token === '"' || token === "'") {
      if (inTag) {
        if (quote === token) quote = undefined
        else if (!quote) quote = token
      }
    } else if (reference !== undefined && !/^(?:lt|gt|amp|quot|apos);$/.test(reference)) {
      const numeric = /^#(?:([0-9]{1,7})|x([0-9A-Fa-f]{1,6}));$/.exec(reference)
      if (!numeric) throw reject('forbidden_markup')
      const code = numeric[1]
        ? Number.parseInt(numeric[1], 10)
        : Number.parseInt(numeric[2] ?? '', 16)
      if (!isXmlChar(code)) throw reject('malformed_xml')
    }
  }
  return comments
}

/**
 * Parses a document with no DTD, CDATA, processing instructions or custom entities.
 * The returned tree omits comments. Signature verification still receives the submitted XML
 * and uses exclusive canonicalization without comments.
 */
export function parseSamlXml(xml: string, inspect?: (element: Element) => void): Element {
  if (Buffer.byteLength(xml) > samlMaximumResponseBytes) throw reject('too_large')
  let run = 0
  for (const character of xml) {
    const code = character.codePointAt(0) ?? 0
    if (!isXmlChar(code)) throw reject('malformed_xml')
    run = isWhitespace(code) ? run + 1 : 0
    if (run > MAX_WHITESPACE_RUN) throw reject('too_large')
  }
  // One leading UTF-8 byte order mark is accepted; the declaration, when present, comes next.
  const declared = (xml.startsWith('\uFEFF') ? xml.slice(1) : xml).replace(XML_DECLARATION, '')
  // White space around the root element is not part of the document's content. Index scans,
  // not a regular expression: an alternation anchored at both ends is quadratic here.
  let start = 0
  let end = declared.length
  while (start < end && isWhitespace(declared.charCodeAt(start))) start += 1
  while (end > start && isWhitespace(declared.charCodeAt(end - 1))) end -= 1
  const body = declared.slice(start, end)
  let nodes = checkMarkup(body)
  let root: Element | null
  try {
    const document = new DOMParser({
      // Warnings included: anything the parser has to repair is refused.
      onError: () => {
        throw reject('malformed_xml')
      },
    }).parseFromString(body, 'text/xml')
    if (document.doctype) throw reject('forbidden_markup')
    root = document.documentElement
    for (const child of Array.from(document.childNodes)) {
      if (child === root || child.nodeType === 8) continue
      if (child.nodeType !== 3 || !/^[\t\r\n ]*$/.test(child.nodeValue ?? ''))
        throw reject('malformed_xml')
    }
  } catch (error) {
    throw error instanceof SamlVerificationError ? error : reject('malformed_xml')
  }
  if (!root) throw reject('malformed_xml')
  const visit = (element: Element, depth: number) => {
    nodes += 1
    if (depth > MAX_DEPTH || nodes > MAX_NODES) throw reject('too_large')
    inspect?.(element)
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) visit(child as Element, depth + 1)
      else if (child.nodeType === 8) element.removeChild(child)
      else if (child.nodeType !== 3) throw reject('forbidden_markup')
    }
  }
  visit(root, 1)
  return root
}

const is = (element: Element, namespace: string, localName: string) =>
  element.namespaceURI === namespace && element.localName === localName

/**
 * Whole-tree rules: element and text nodes only, known namespaces only, no encrypted
 * element, unqualified attributes only (besides namespace declarations and `xsi:type` on an
 * attribute value), and ID attributes only on the Response and the Assertion, each unique.
 */
function parseStrict(xml: string) {
  const ids = new Set<string>()
  return parseSamlXml(xml, (element) => {
    if (ENCRYPTED.has(element.localName ?? '')) throw reject('encrypted_unsupported')
    if (!ELEMENT_NAMESPACES.has(element.namespaceURI ?? '')) throw reject('unexpected_namespace')
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'xmlns') continue
      if (attribute.prefix === 'xmlns') {
        // A prefix named like an ID attribute could be mistaken for one by an ID lookup.
        if (attribute.localName?.toLowerCase() === 'id') throw reject('unexpected_structure')
        continue
      }
      if (attribute.namespaceURI) {
        const typed =
          attribute.namespaceURI === XSI &&
          attribute.localName === 'type' &&
          is(element, SAML, 'AttributeValue')
        if (!typed) throw reject('unexpected_namespace')
        continue
      }
      if (attribute.prefix) throw reject('unexpected_namespace')
      if (attribute.name.toLowerCase() !== 'id') continue
      const owner = is(element, SAMLP, 'Response') || is(element, SAML, 'Assertion')
      if (!owner || attribute.name !== 'ID' || !XML_ID.test(attribute.value))
        throw reject('unexpected_structure')
      if (ids.has(attribute.value)) throw reject('duplicate_id')
      ids.add(attribute.value)
    }
  })
}

/** The element children of an element that may hold nothing else but white space. */
function children(element: Element): Element[] {
  const found: Element[] = []
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) found.push(child as Element)
    else if ((child.nodeValue ?? '').trim() !== '') throw reject('unexpected_structure')
  }
  return found
}

/** The text of an element that may hold no element. */
function text(element: Element): string {
  let value = ''
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== 3) throw reject('unexpected_structure')
    value += child.nodeValue ?? ''
  }
  return value
}

const optional = (element: Element, name: string) =>
  element.hasAttribute(name) ? element.getAttribute(name) : null

function required(element: Element, name: string): string {
  const value = optional(element, name)
  if (!value) throw reject('unexpected_structure')
  return value
}

/** Requires the children to be exactly the named sequence, in order; `?` marks optional. */
function sequence(element: Element, namespace: string, names: readonly string[]) {
  const remaining = children(element)
  const found: (Element | undefined)[] = names.map((name) => {
    const next = remaining[0]
    const wanted = name.replace('?', '')
    if (next && is(next, namespace, wanted)) return remaining.shift()
    if (name.endsWith('?')) return undefined
    throw reject('unexpected_structure')
  })
  if (remaining.length > 0) throw reject('unexpected_structure')
  return found
}

function descendants(root: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = []
  const visit = (element: Element) => {
    if (is(element, namespace, localName)) found.push(element)
    for (const child of Array.from(element.childNodes))
      if (child.nodeType === 1) visit(child as Element)
  }
  visit(root)
  return found
}

// ---------------------------------------------------------------------------------------
// Configuration

type Trust = {
  config: SamlVerifierConfig
  keys: string[]
  signature: Set<string>
  digest: Set<string>
  canonicalization: Set<string>
}

/** A configured X.509 certificate whose public key can verify our signature profile. */
export function samlSigningCertificate(certificate: string): X509Certificate {
  try {
    if (typeof certificate !== 'string') throw reject('invalid_configuration')
    const parsed = new X509Certificate(
      certificate.includes('-----BEGIN') ? certificate : Buffer.from(certificate, 'base64'),
    )
    const { publicKey } = parsed
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0
    if (publicKey.asymmetricKeyType !== 'rsa' || bits < 2048) throw reject('invalid_configuration')
    return parsed
  } catch {
    throw reject('invalid_configuration')
  }
}

function trustFrom(config: SamlVerifierConfig): Trust {
  const invalid = reject('invalid_configuration')
  const { algorithms, signingCertificates } = config ?? {}
  for (const value of [config?.idpEntityId, config?.spEntityId, config?.acsUrl])
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) throw invalid
  const lists = [algorithms?.signature, algorithms?.digest, algorithms?.canonicalization]
  if (!lists.every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string')))
    throw invalid
  // An algorithm this verifier does not implement can never be configured in (SHA-1 included).
  if (
    !algorithms.signature.every((uri) => IMPLEMENTED.signature.has(uri)) ||
    !algorithms.digest.every((uri) => IMPLEMENTED.digest.has(uri)) ||
    !algorithms.canonicalization.every((uri) => IMPLEMENTED.canonicalization.has(uri))
  )
    throw invalid
  if (
    !Array.isArray(signingCertificates) ||
    signingCertificates.length === 0 ||
    signingCertificates.length > samlMaximumSigningCertificates
  )
    throw invalid
  const keys = signingCertificates.map((certificate) =>
    samlSigningCertificate(certificate)
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString(),
  )
  return {
    config,
    keys,
    signature: new Set(algorithms.signature),
    digest: new Set(algorithms.digest),
    canonicalization: new Set(algorithms.canonicalization),
  }
}

// ---------------------------------------------------------------------------------------
// Signature profile and verification

/**
 * Checks that a Signature element is the one shape accepted: an enveloped signature with a
 * single same-document Reference to the element that contains it, and configured algorithms
 * only. Returns the digest algorithm and the DigestValue the consumed bytes must hash to.
 */
function signatureProfile(signature: Element, ownerId: string, trust: Trust) {
  const [signedInfo, signatureValue, keyInfo] = sequence(signature, DSIG, [
    'SignedInfo',
    'SignatureValue',
    'KeyInfo?',
  ])
  if (!signedInfo || !signatureValue) throw reject('unexpected_structure')
  const [canonicalization, method, reference] = sequence(signedInfo, DSIG, [
    'CanonicalizationMethod',
    'SignatureMethod',
    'Reference',
  ])
  if (!canonicalization || !method || !reference) throw reject('unexpected_structure')

  const uri = optional(reference, 'URI')
  if (uri === null || uri === '') throw reject('signature_reference_mismatch')
  if (!uri.startsWith('#')) throw reject('external_reference')
  if (uri !== `#${ownerId}`) throw reject('signature_reference_mismatch')
  if (Array.from(reference.attributes).some(({ name }) => name !== 'URI'))
    throw reject('unexpected_structure')

  const canonical = (element: Element) => {
    if (!trust.canonicalization.has(optional(element, 'Algorithm') ?? ''))
      throw reject('algorithm_not_allowed')
    const [prefixes] = sequence(element, EXC_C14N, ['InclusiveNamespaces?'])
    if (prefixes && children(prefixes).length > 0) throw reject('unexpected_structure')
  }
  canonical(canonicalization)
  if (!trust.signature.has(optional(method, 'Algorithm') ?? ''))
    throw reject('algorithm_not_allowed')
  if (children(method).length > 0) throw reject('algorithm_not_allowed')

  const [transforms, digestMethod, digestValue] = sequence(reference, DSIG, [
    'Transforms',
    'DigestMethod',
    'DigestValue',
  ])
  if (!transforms || !digestMethod || !digestValue) throw reject('unexpected_structure')
  const steps = children(transforms)
  const [enveloped, canonicalize] = steps
  if (steps.some((step) => !is(step, DSIG, 'Transform'))) throw reject('unexpected_structure')
  // Exactly enveloped-signature, then a configured canonicalization. No XPath, no XSLT.
  if (
    steps.length !== 2 ||
    !enveloped ||
    !canonicalize ||
    optional(enveloped, 'Algorithm') !== ENVELOPED_SIGNATURE ||
    enveloped.childNodes.length > 0
  )
    throw reject('algorithm_not_allowed')
  canonical(canonicalize)
  const digestAlgorithm = optional(digestMethod, 'Algorithm') ?? ''
  const hash = IMPLEMENTED.digest.get(digestAlgorithm)
  if (!trust.digest.has(digestAlgorithm) || !hash || digestMethod.childNodes.length > 0)
    throw reject('algorithm_not_allowed')
  const digest = text(digestValue).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]{43}=$/.test(digest)) throw reject('unexpected_structure')

  // KeyInfo is never a source of trust and never read: inline X509Data, KeyName and KeyValue
  // are ignored, and anything that points elsewhere (RetrievalMethod and the like) is refused.
  if (keyInfo)
    for (const child of children(keyInfo)) {
      if (is(child, DSIG, 'RetrievalMethod')) throw reject('external_reference')
      const ignored = ['X509Data', 'KeyName', 'KeyValue'].some((name) => is(child, DSIG, name))
      if (!ignored) throw reject('unexpected_structure')
    }
  return { hash, digest: Buffer.from(digest, 'base64') }
}

/**
 * Verifies one enveloped signature against the configured keys and returns the canonical
 * bytes xml-crypto digested for its single reference.
 */
function signedBytes(xml: string, signature: Element, ownerId: string, trust: Trust): string {
  const expected = signatureProfile(signature, ownerId, trust)
  for (const key of trust.keys) {
    const verifier = new SignedXml({ publicCert: key, getCertFromKeyInfo: () => null })
    // The library instance itself knows only the configured algorithms.
    const keep = (table: Record<string, unknown>, allowed: (uri: string) => boolean) => {
      for (const uri of Object.keys(table)) if (!allowed(uri)) delete table[uri]
    }
    keep(
      verifier.CanonicalizationAlgorithms,
      (uri) => uri === ENVELOPED_SIGNATURE || trust.canonicalization.has(uri),
    )
    keep(verifier.HashAlgorithms, (uri) => trust.digest.has(uri))
    keep(verifier.SignatureAlgorithms, (uri) => trust.signature.has(uri))
    let references: string[]
    try {
      // xml-crypto accepts xmldom nodes at runtime. Its types use the browser's DOM Node.
      verifier.loadSignature(signature as unknown as Parameters<SignedXml['loadSignature']>[0])
      if (!verifier.checkSignature(xml)) continue
      references = verifier.getSignedReferences()
    } catch {
      continue
    }
    const [bytes] = references
    if (references.length !== 1 || typeof bytes !== 'string') throw reject('verified_node_mismatch')
    // Bind what is consumed to the signed DigestValue, in constant time.
    const actual = createHash(expected.hash).update(bytes, 'utf8').digest()
    if (actual.length !== expected.digest.length || !timingSafeEqual(actual, expected.digest))
      throw reject('verified_node_mismatch')
    return bytes
  }
  throw reject('signature_invalid')
}

// ---------------------------------------------------------------------------------------
// Reading

function readIssuer(issuer: Element, trust: Trust) {
  const format = optional(issuer, 'Format')
  if (format !== null && format !== ENTITY_FORMAT) throw reject('issuer_mismatch')
  if (
    Array.from(issuer.attributes).some(({ name }) => name !== 'Format' && !name.startsWith('xmlns'))
  )
    throw reject('issuer_mismatch')
  const value = text(issuer)
  if (value !== trust.config.idpEntityId) throw reject('issuer_mismatch')
  return value
}

function readResponse(response: Element, trust: Trust) {
  if (!is(response, SAMLP, 'Response')) throw reject('unexpected_structure')
  if (optional(response, 'Version') !== '2.0') throw reject('unexpected_structure')
  const [issuer, signature, status, assertion] = responseParts(response)
  if (!status || !assertion) throw reject('unexpected_structure')
  if (issuer) readIssuer(issuer, trust)
  const [code, ...rest] = children(status)
  if (!code || !is(code, SAMLP, 'StatusCode') || rest.some((part) => part.namespaceURI !== SAMLP))
    throw reject('unexpected_structure')
  if (optional(code, 'Value') !== STATUS_SUCCESS || children(code).length > 0)
    throw reject('status_not_success')
  const destination = optional(response, 'Destination')
  if (destination !== trust.config.acsUrl) throw reject('destination_mismatch')
  return {
    signature,
    assertion,
    fields: {
      id: required(response, 'ID'),
      issueInstant: required(response, 'IssueInstant'),
      inResponseTo: required(response, 'InResponseTo'),
      destination,
    },
  }
}

/** Response children: optional Issuer, optional Signature, Status, exactly one Assertion. */
function responseParts(response: Element) {
  const parts = children(response)
  const take = (namespace: string, localName: string) => {
    const next = parts[0]
    return next && is(next, namespace, localName) ? parts.shift() : undefined
  }
  const issuer = take(SAML, 'Issuer')
  const signature = take(DSIG, 'Signature')
  const status = take(SAMLP, 'Status')
  const assertion = take(SAML, 'Assertion')
  if (assertion && parts.some((part) => is(part, SAML, 'Assertion')))
    throw reject('multiple_assertions')
  if (parts.length > 0) throw reject('unexpected_structure')
  return [issuer, signature, status, assertion] as const
}

/** Reads the assertion. Only ever called with the root of the verified canonical bytes. */
function readAssertion(assertion: Element, trust: Trust): VerifiedSamlResponse['assertion'] {
  if (!is(assertion, SAML, 'Assertion')) throw reject('verified_node_mismatch')
  if (optional(assertion, 'Version') !== '2.0') throw reject('unexpected_structure')
  const parts = children(assertion)
  const take = (localName: string) => {
    const next = parts[0]
    return next && is(next, SAML, localName) ? parts.shift() : undefined
  }
  const issuer = take('Issuer')
  // The enveloped-signature transform removed the Signature from the signed bytes.
  const subject = take('Subject')
  const conditions = take('Conditions')
  if (!issuer || !subject || !conditions) throw reject('unexpected_structure')

  const [nameId, confirmation] = sequence(subject, SAML, ['NameID', 'SubjectConfirmation'])
  if (!nameId || !confirmation) throw reject('unexpected_structure')
  const nameIdValue = text(nameId)
  if (nameIdValue.trim() === '') throw reject('unexpected_structure')
  if (optional(confirmation, 'Method') !== BEARER) throw reject('unexpected_structure')
  const [data] = sequence(confirmation, SAML, ['SubjectConfirmationData'])
  if (!data || data.childNodes.length > 0) throw reject('unexpected_structure')
  const recipient = optional(data, 'Recipient')
  if (recipient !== trust.config.acsUrl) throw reject('recipient_mismatch')

  const audiences: string[] = []
  let restrictions = 0
  for (const condition of children(conditions)) {
    if (is(condition, SAML, 'OneTimeUse') || is(condition, SAML, 'ProxyRestriction')) continue
    if (!is(condition, SAML, 'AudienceRestriction')) throw reject('unexpected_structure')
    const named = children(condition).map((audience) => {
      if (!is(audience, SAML, 'Audience')) throw reject('unexpected_structure')
      return text(audience)
    })
    // Restrictions are conjunctive: every one of them must name this service provider.
    if (!named.includes(trust.config.spEntityId)) throw reject('audience_mismatch')
    audiences.push(...named)
    restrictions += 1
  }
  if (restrictions === 0) throw reject('audience_mismatch')

  const authnStatements: VerifiedSamlResponse['assertion']['authnStatements'] = []
  // No prototype: `attributes.constructor` and the like are undefined, not inherited values.
  const attributes: Record<string, string[]> = Object.create(null)
  for (const statement of parts) {
    if (is(statement, SAML, 'AuthnStatement')) {
      authnStatements.push({
        authnInstant: required(statement, 'AuthnInstant'),
        sessionIndex: optional(statement, 'SessionIndex'),
        sessionNotOnOrAfter: optional(statement, 'SessionNotOnOrAfter'),
      })
    } else if (is(statement, SAML, 'AttributeStatement')) {
      for (const attribute of children(statement)) {
        if (!is(attribute, SAML, 'Attribute')) throw reject('unexpected_structure')
        const name = required(attribute, 'Name')
        // The same name twice, in one statement or across statements, has no single reading.
        if (Object.hasOwn(attributes, name)) throw reject('ambiguous_attribute')
        Object.defineProperty(attributes, name, {
          value: children(attribute).map((value) => {
            if (!is(value, SAML, 'AttributeValue')) throw reject('unexpected_structure')
            return text(value)
          }),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    } else throw reject('unexpected_structure')
  }
  if (authnStatements.length === 0) throw reject('unexpected_structure')

  return {
    id: required(assertion, 'ID'),
    issueInstant: required(assertion, 'IssueInstant'),
    issuer: readIssuer(issuer, trust),
    nameId: {
      value: nameIdValue,
      format: optional(nameId, 'Format'),
      nameQualifier: optional(nameId, 'NameQualifier'),
      spNameQualifier: optional(nameId, 'SPNameQualifier'),
    },
    subjectConfirmation: {
      recipient,
      inResponseTo: required(data, 'InResponseTo'),
      notBefore: optional(data, 'NotBefore'),
      notOnOrAfter: optional(data, 'NotOnOrAfter'),
    },
    conditions: {
      notBefore: optional(conditions, 'NotBefore'),
      notOnOrAfter: optional(conditions, 'NotOnOrAfter'),
    },
    audiences,
    authnStatements,
    attributes,
  }
}

function decode(samlResponse: unknown): string {
  if (typeof samlResponse !== 'string' || samlResponse.length === 0)
    throw reject('invalid_encoding')
  if (samlResponse.length > samlMaximumResponseBytes * 2) throw reject('too_large')
  const base64 = samlResponse.replace(/[\r\n\t ]+/g, '')
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw reject('invalid_encoding')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > samlMaximumResponseBytes) throw reject('too_large')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw reject('invalid_encoding')
  }
}

/**
 * Verifies the base64 `SAMLResponse` of an HTTP-POST binding against trusted provider
 * configuration. Throws {@link SamlVerificationError} for anything it does not fully accept.
 */
export function verifySamlResponse(
  config: SamlVerifierConfig,
  samlResponse: unknown,
): VerifiedSamlResponse {
  const trust = trustFrom(config)
  try {
    const xml = decode(samlResponse)
    const submitted = parseStrict(xml)
    const outer = readResponse(submitted, trust)
    if (descendants(submitted, SAML, 'Assertion').length !== 1) throw reject('multiple_assertions')
    if (descendants(submitted, SAMLP, 'Response').length !== 1) throw reject('unexpected_structure')

    const assertionId = required(outer.assertion, 'ID')
    const assertionSignatures = children(outer.assertion).filter((child) =>
      is(child, DSIG, 'Signature'),
    )
    const [assertionSignature] = assertionSignatures
    // A signature on the Response alone does not authenticate the assertion for this profile.
    if (assertionSignatures.length !== 1 || !assertionSignature)
      throw reject('assertion_signature_required')
    // No signature anywhere except directly under the element it signs.
    const expectedSignatures = outer.signature ? 2 : 1
    if (descendants(submitted, DSIG, 'Signature').length !== expectedSignatures)
      throw reject('unexpected_structure')

    // From here on, values come only from the bytes whose digests the signatures cover.
    let response = outer.fields
    if (outer.signature) {
      const verified = readResponse(
        parseStrict(signedBytes(xml, outer.signature, outer.fields.id, trust)),
        trust,
      )
      if (
        verified.fields.id !== outer.fields.id ||
        required(verified.assertion, 'ID') !== assertionId
      )
        throw reject('verified_node_mismatch')
      response = verified.fields
    }
    const assertion = readAssertion(
      parseStrict(signedBytes(xml, assertionSignature, assertionId, trust)),
      trust,
    )
    if (assertion.id !== assertionId) throw reject('verified_node_mismatch')
    if (assertion.subjectConfirmation.inResponseTo !== response.inResponseTo)
      throw reject('in_response_to_mismatch')
    return { response: { ...response, signed: Boolean(outer.signature) }, assertion }
  } catch (error) {
    // Fail closed: an unexpected library or runtime error is a rejection, never a pass.
    throw error instanceof SamlVerificationError ? error : reject('malformed_xml')
  }
}
