import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DOMParser } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SignedXml } from 'xml-crypto'
import { samlProviderValues, ssoFixture } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { samlSigningIdentity as identity } from './sso-saml-fixtures.ts'
import {
  consumeSamlReplay,
  purgeExpiredSamlReplay,
  SamlTimingError,
  validateSamlTiming,
} from './sso-saml-replay.ts'
import {
  type SamlRejection,
  SamlVerificationError,
  type SamlVerifierConfig,
  samlInitialAlgorithms,
  samlMaximumResponseBytes,
  verifySamlResponse,
} from './sso-saml-verifier.ts'

// Every document below is a real XML document, signed with real RSA keys by xml-crypto and
// then, for the negative corpus, altered the way an attacker would alter it.

const IDP = 'https://idp.example.test/realms/acme'
const SP = 'https://hourmere.example.test/api/auth/sso/saml2/sp/metadata/provider-a'
const ACS = 'https://hourmere.example.test/api/auth/sso/saml2/sp/acs/provider-a'
const REQUEST = '_request-5f1c'

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
const RSA_SHA512 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512'
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'
const SHA512 = 'http://www.w3.org/2001/04/xmlenc#sha512'
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'

type Identity = ReturnType<typeof identity>
const idp = identity('idp.example.test')
const rotated = identity('idp-next.example.test')
const attacker = identity('idp.example.test')

const config: SamlVerifierConfig = {
  idpEntityId: IDP,
  spEntityId: SP,
  acsUrl: ACS,
  signingCertificates: [idp.pem],
  algorithms: samlInitialAlgorithms,
}

// --- documents ------------------------------------------------------------------------------

type AssertionOptions = {
  id?: string
  issueInstant?: string | null
  issuer?: string
  nameId?: string
  subject?: string
  recipient?: string | null
  inResponseTo?: string
  conditions?: string
  conditionsAttributes?: string
  confirmationNotBefore?: string | null
  confirmationNotOnOrAfter?: string | null
  statements?: string
}

function assertionXml(options: AssertionOptions = {}) {
  const {
    id = '_assertion-a1',
    issueInstant = '2026-06-12T12:00:00Z',
    issuer = IDP,
    nameId = 'ada@acme.example',
    recipient = ACS,
    inResponseTo = REQUEST,
    conditionsAttributes = ' NotBefore="2026-06-12T11:59:00Z" NotOnOrAfter="2026-06-12T12:05:00Z"',
    confirmationNotBefore = null,
    confirmationNotOnOrAfter = '2026-06-12T12:05:00Z',
    conditions = `<saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction>`,
    statements = `<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z" SessionIndex="_session-1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>ada@acme.example</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>staff</saml:AttributeValue><saml:AttributeValue>owners</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`,
  } = options
  const subject =
    options.subject ??
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${inResponseTo}"${confirmationNotBefore === null ? '' : ` NotBefore="${confirmationNotBefore}"`}${confirmationNotOnOrAfter === null ? '' : ` NotOnOrAfter="${confirmationNotOnOrAfter}"`}${recipient === null ? '' : ` Recipient="${recipient}"`}/></saml:SubjectConfirmation>`
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}"${issueInstant === null ? '' : ` IssueInstant="${issueInstant}"`} Version="2.0"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject>${subject}</saml:Subject><saml:Conditions${conditionsAttributes}>${conditions}</saml:Conditions>${statements}</saml:Assertion>`
}

type ResponseOptions = {
  id?: string
  destination?: string | null
  inResponseTo?: string
  status?: string
  assertion?: string
}

function responseXml(options: ResponseOptions = {}) {
  const {
    id = '_response-r1',
    destination = ACS,
    inResponseTo = REQUEST,
    status = '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>',
    assertion = assertionXml(),
  } = options
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" InResponseTo="${inResponseTo}" IssueInstant="2026-06-12T12:00:01Z" Version="2.0"${destination === null ? '' : ` Destination="${destination}"`}><saml:Issuer>${IDP}</saml:Issuer><samlp:Status>${status}</samlp:Status>${assertion}</samlp:Response>`
}

type SignOptions = {
  by?: Identity
  keyInfo?: boolean
  signatureAlgorithm?: string
  digestAlgorithm?: string
  canonicalization?: string
  transforms?: string[]
  emptyUri?: boolean
  inclusivePrefixes?: string[]
}

/** Adds an enveloped signature to the first `Assertion` or `Response` element. */
function sign(xml: string, target: 'Assertion' | 'Response', options: SignOptions = {}) {
  const {
    by = idp,
    keyInfo = true,
    signatureAlgorithm = RSA_SHA256,
    digestAlgorithm = SHA256,
    canonicalization = EXC_C14N,
    transforms = [ENVELOPED, canonicalization],
    emptyUri = false,
    inclusivePrefixes,
  } = options
  const signer = new SignedXml({
    privateKey: by.privateKey,
    publicCert: keyInfo ? by.pem : undefined,
    signatureAlgorithm,
    canonicalizationAlgorithm: canonicalization,
  })
  const element = `(//*[local-name(.)='${target}'])[1]`
  signer.addReference({
    xpath: emptyUri ? '/*' : element,
    transforms,
    digestAlgorithm,
    isEmptyUri: emptyUri,
    inclusiveNamespacesPrefixList: inclusivePrefixes,
  })
  signer.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: `${element}/*[local-name(.)='Issuer']`, action: 'after' },
  })
  return signer.getSignedXml()
}

const encode = (xml: string) => Buffer.from(xml, 'utf8').toString('base64')
const signedAssertion = (options?: AssertionOptions, signing?: SignOptions) =>
  sign(assertionXml(options), 'Assertion', signing)
const valid = (assertion?: AssertionOptions, response?: ResponseOptions) =>
  responseXml({ ...response, assertion: signedAssertion(assertion) })

/** Splits a document around its first top-level `saml:Assertion` and that one's signature. */
function parts(xml: string) {
  const start = xml.indexOf('<saml:Assertion')
  const end = xml.lastIndexOf('</saml:Assertion>') + '</saml:Assertion>'.length
  const assertion = xml.slice(start, end)
  const signatureStart = assertion.indexOf('<ds:Signature')
  const signatureEnd = assertion.indexOf('</ds:Signature>') + '</ds:Signature>'.length
  const signature = assertion.slice(signatureStart, signatureEnd)
  return {
    before: xml.slice(0, start),
    assertion,
    after: xml.slice(end),
    signature,
    unsignedAssertion: assertion.slice(0, signatureStart) + assertion.slice(signatureEnd),
  }
}

function rejection(xml: string, settings: SamlVerifierConfig = config): SamlRejection | 'accepted' {
  try {
    verifySamlResponse(settings, encode(xml))
    return 'accepted'
  } catch (error) {
    if (error instanceof SamlVerificationError) return error.reason
    throw error
  }
}

// The forged assertion every wrapping attack tries to get consumed.
const forged = (id = '_assertion-evil') => assertionXml({ id, nameId: 'mallory@evil.example' })
const forgedBody = (xml: string) =>
  xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf('</saml:Assertion>'))

afterEach(() => vi.restoreAllMocks())

describe('SAML verifier: accepted responses', () => {
  it('accepts a response whose assertion is signed by the configured certificate', () => {
    const result = verifySamlResponse(config, encode(valid()))
    expect(result).toEqual({
      response: {
        id: '_response-r1',
        signed: false,
        issueInstant: '2026-06-12T12:00:01Z',
        inResponseTo: REQUEST,
        destination: ACS,
      },
      assertion: {
        id: '_assertion-a1',
        issueInstant: '2026-06-12T12:00:00Z',
        issuer: IDP,
        nameId: {
          value: 'ada@acme.example',
          format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          nameQualifier: null,
          spNameQualifier: null,
        },
        subjectConfirmation: {
          recipient: ACS,
          inResponseTo: REQUEST,
          notBefore: null,
          notOnOrAfter: '2026-06-12T12:05:00Z',
        },
        conditions: { notBefore: '2026-06-12T11:59:00Z', notOnOrAfter: '2026-06-12T12:05:00Z' },
        audiences: [SP],
        authnStatements: [
          {
            authnInstant: '2026-06-12T11:59:58Z',
            sessionIndex: '_session-1',
            sessionNotOnOrAfter: null,
          },
        ],
        attributes: { email: ['ada@acme.example'], groups: ['staff', 'owners'] },
      },
    })
  })

  it('validates a response signature too when the response carries one', () => {
    const both = sign(valid(), 'Response')
    expect(verifySamlResponse(config, encode(both)).response.signed).toBe(true)
    // The assertion signature is intact, but the signed response was altered afterwards.
    const altered = both.replace(
      'IssueInstant="2026-06-12T12:00:01Z"',
      'IssueInstant="2027-01-01T00:00:00Z"',
    )
    expect(altered).not.toBe(both)
    expect(rejection(altered)).toBe('signature_invalid')
    // A response signature from another key is not ignored because the assertion verifies.
    expect(rejection(sign(valid(), 'Response', { by: attacker }))).toBe('signature_invalid')
  })

  it('accepts either configured certificate during rotation, with or without KeyInfo', () => {
    const next = responseXml({
      assertion: signedAssertion(undefined, { by: rotated, keyInfo: false }),
    })
    expect(next).not.toContain('X509Certificate')
    expect(rejection(next)).toBe('signature_invalid')
    const overlapping = { ...config, signingCertificates: [idp.pem, rotated.base64] }
    expect(rejection(next, overlapping)).toBe('accepted')
    expect(rejection(valid(), overlapping)).toBe('accepted')
  })

  it('accepts the post binding form with line breaks in the base64 text', () => {
    const wrapped = encode(`<?xml version="1.0" encoding="UTF-8"?>${valid()}`).replace(
      /(.{76})/g,
      '$1\r\n',
    )
    expect(verifySamlResponse(config, wrapped).assertion.nameId.value).toBe('ada@acme.example')
    // White space around the root element, as IdPs commonly emit it.
    expect(rejection(`<?xml version="1.0" encoding="UTF-8"?>\n${valid()}\n`)).toBe('accepted')
    expect(rejection(`\n  ${valid()}\r\n`)).toBe('accepted')
    // Indentation added to the unsigned wrapper after signing changes nothing that is signed.
    expect(rejection(valid().replace('<samlp:Status>', '\n  <samlp:Status>'))).toBe('accepted')
  })
})

describe('SAML verifier: the verified node is the consumed node', () => {
  it('returns only what is in the canonical bytes the signature digest covers', () => {
    const digested = vi.spyOn(SignedXml.prototype, 'getSignedReferences')
    const document = valid()
    const result = verifySamlResponse(config, encode(document))
    const [bytes] = (digested.mock.results.at(-1)?.value ?? []) as string[]
    // Those bytes hash to the DigestValue inside the signed SignedInfo of the submitted document.
    const digestValue = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(document)?.[1]
    expect(
      createHash('sha256')
        .update(bytes ?? '', 'utf8')
        .digest('base64'),
    ).toBe(digestValue)
    // An independent parse of the same bytes yields exactly the returned values.
    const root = new DOMParser().parseFromString(bytes ?? '', 'text/xml').documentElement
    const first = (name: string) => root?.getElementsByTagName(name)[0]
    expect(root?.getAttribute('ID')).toBe(result.assertion.id)
    expect(first('saml:NameID')?.textContent).toBe(result.assertion.nameId.value)
    expect(first('saml:Audience')?.textContent).toBe(result.assertion.audiences[0])
    expect(first('saml:SubjectConfirmationData')?.getAttribute('Recipient')).toBe(
      result.assertion.subjectConfirmation.recipient,
    )
    expect(
      Array.from(root?.getElementsByTagName('saml:AttributeValue') ?? []).map(
        (value) => value.textContent,
      ),
    ).toEqual(Object.values(result.assertion.attributes).flat())
    // The signed bytes hold no signature: the enveloped transform removed it before digesting.
    expect(bytes).not.toContain('Signature')
  })

  it('refuses when the bytes handed back are not the ones the signed digest covers', () => {
    // The signature library is made to hand back a different, well-formed assertion with the
    // same ID after a genuine signature check: the digest binding must refuse it, so no value
    // can ever come from a node other than the digested one.
    vi.spyOn(SignedXml.prototype, 'getSignedReferences').mockReturnValue([forged('_assertion-a1')])
    expect(rejection(valid())).toBe('verified_node_mismatch')
    vi.spyOn(SignedXml.prototype, 'getSignedReferences').mockReturnValue([])
    expect(rejection(valid())).toBe('verified_node_mismatch')
  })

  it('reads the values of the signed assertion when the unsigned wrapper disagrees', () => {
    // Nothing in the unsigned wrapper can stand in for a signed value.
    const wrapper = valid().replace(
      '<samlp:Status>',
      '<samlp:Status><samlp:StatusMessage>NameID=mallory@evil.example</samlp:StatusMessage>',
    )
    expect(rejection(wrapper)).toBe('unexpected_structure')
    const result = verifySamlResponse(config, encode(valid({}, { id: '_another-wrapper' })))
    expect(result.response.id).toBe('_another-wrapper')
    expect(result.assertion.nameId.value).toBe('ada@acme.example')
  })
})

describe('SAML negative corpus: duplicate IDs', () => {
  it('refuses a response and an assertion that share an ID, even though the signature verifies', () => {
    const document = valid({ id: '_same' }, { id: '_same' })
    expect(rejection(document)).toBe('duplicate_id')
  })

  it('refuses a second element that repeats the signed assertion ID', () => {
    const { before, assertion, after, signature } = parts(valid())
    const twin = forged('_assertion-a1').replace('<saml:Subject>', `${signature}<saml:Subject>`)
    expect(rejection(before + twin + assertion + after)).toBe('duplicate_id')
    expect(rejection(before + assertion + twin + after)).toBe('duplicate_id')
  })

  it('refuses an ID attribute anywhere but on the response and the assertion', () => {
    const hidden = valid().replace('<samlp:Status>', '<samlp:Status ID="_assertion-a1x">')
    expect(rejection(hidden)).toBe('unexpected_structure')
    const lower = valid().replace('<samlp:Status>', '<samlp:Status Id="_assertion-a1">')
    expect(rejection(lower)).toBe('unexpected_structure')
  })
})

describe('SAML negative corpus: signature wrapping', () => {
  // In each case the genuine signed assertion is still present and its signature still
  // verifies; the forged assertion sits where a careless consumer would read it.
  const cases: [string, () => string, SamlRejection][] = [
    [
      'XSW3: forged assertion placed before the signed one',
      () => {
        const { before, assertion, after } = parts(valid())
        return before + forged() + assertion + after
      },
      'multiple_assertions',
    ],
    [
      'forged assertion placed after the signed one',
      () => {
        const { before, assertion, after } = parts(valid())
        return before + assertion + forged() + after
      },
      'multiple_assertions',
    ],
    [
      'XSW4: forged assertion wrapping the signed one',
      () => {
        const { before, assertion, after } = parts(valid())
        return `${before}${forged().replace('</saml:Assertion>', `${assertion}</saml:Assertion>`)}${after}`
      },
      'multiple_assertions',
    ],
    [
      'XSW5: forged assertion carrying the copied signature, original appended unsigned',
      () => {
        const { before, after, signature, unsignedAssertion } = parts(valid())
        const carrier = forged().replace('<saml:Subject>', `${signature}<saml:Subject>`)
        return before + carrier + unsignedAssertion + after
      },
      'multiple_assertions',
    ],
    [
      'XSW6: forged assertion whose signature contains the original assertion',
      () => {
        const { before, after, signature, unsignedAssertion } = parts(valid())
        const nest = signature.replace('</ds:Signature>', `${unsignedAssertion}</ds:Signature>`)
        return before + forged().replace('<saml:Subject>', `${nest}<saml:Subject>`) + after
      },
      'multiple_assertions',
    ],
    [
      'XSW7: forged assertion inside Extensions before the signed one',
      () => {
        const { before, assertion, after } = parts(valid())
        return `${before.replace('<samlp:Status>', `<samlp:Extensions>${forged()}</samlp:Extensions><samlp:Status>`)}${assertion}${after}`
      },
      'unexpected_structure',
    ],
    [
      'XSW8: forged assertion whose signature holds the original inside ds:Object',
      () => {
        const { before, after, signature, unsignedAssertion } = parts(valid())
        const nest = signature.replace(
          '</ds:Signature>',
          `<ds:Object>${unsignedAssertion}</ds:Object></ds:Signature>`,
        )
        return before + forged().replace('<saml:Subject>', `${nest}<saml:Subject>`) + after
      },
      'multiple_assertions',
    ],
    [
      'signed assertion hidden inside the forged SubjectConfirmationData',
      () => {
        const { before, assertion, after } = parts(valid())
        const carrier = forged().replace(
          /<saml:SubjectConfirmationData([^>]*)\/>/,
          `<saml:SubjectConfirmationData$1>${assertion}</saml:SubjectConfirmationData>`,
        )
        return before + carrier + after
      },
      'multiple_assertions',
    ],
    [
      'XSW1: forged response wrapping the signed response, signature kept on the forgery',
      () => {
        const original = sign(valid(), 'Response')
        const start = original.indexOf('<ds:Signature')
        const end = original.indexOf('</ds:Signature>') + '</ds:Signature>'.length
        const signature = original.slice(start, end)
        const inner = original.slice(0, start) + original.slice(end)
        return responseXml({ id: '_response-evil', assertion: forged() })
          .replace('<samlp:Status>', `${signature}<samlp:Status>`)
          .replace('</samlp:Response>', `${inner}</samlp:Response>`)
      },
      'unexpected_structure',
    ],
    [
      'XSW2: forged response wrapping the intact signed response',
      () => {
        const original = sign(valid(), 'Response')
        return responseXml({ id: '_response-evil', assertion: forged() }).replace(
          '</samlp:Response>',
          `${original}</samlp:Response>`,
        )
      },
      'unexpected_structure',
    ],
    [
      'forged content appended inside the signed assertion element',
      () => valid().replace('</saml:Assertion>', `${forgedBody(forged())}</saml:Assertion>`),
      'signature_invalid',
    ],
    [
      'signature moved from the assertion to a forged assertion with another ID',
      () => {
        const { before, after, signature } = parts(valid())
        return before + forged().replace('<saml:Subject>', `${signature}<saml:Subject>`) + after
      },
      'signature_reference_mismatch',
    ],
  ]

  it.each(cases)('%s', (_name, build, reason) => {
    const document = build()
    // The crafted document is well-formed and really contains the forgery.
    expect(new DOMParser().parseFromString(document, 'text/xml').documentElement).toBeTruthy()
    expect(document).toContain('mallory@evil.example')
    expect(rejection(document)).toBe(reason)
  })

  it('refuses a comment that would truncate the signed NameID for a careless reader', () => {
    const assertion = sign(
      assertionXml({ nameId: 'ada@acme.example<!---->.evil.example' }),
      'Assertion',
    )
    expect(rejection(responseXml({ assertion }))).toBe('forbidden_markup')
  })
})

describe('SAML negative corpus: DTD, entities and other active markup', () => {
  // The assertion signature stays valid in all of these: only the markup is the problem.
  const withEntity = (doctype: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>${doctype}${valid().replace(
      '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>',
      '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/><samlp:StatusMessage>&xxe;</samlp:StatusMessage>',
    )}`
  const cases: [string, string][] = [
    ['internal entity', withEntity('<!DOCTYPE r [<!ENTITY xxe "expanded">]>')],
    [
      'external file entity',
      withEntity('<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'),
    ],
    [
      'external network entity',
      withEntity('<!DOCTYPE r [<!ENTITY xxe SYSTEM "http://127.0.0.1:9/xxe">]>'),
    ],
    [
      'external parameter entity',
      withEntity('<!DOCTYPE r [<!ENTITY % remote SYSTEM "http://127.0.0.1:9/evil.dtd"> %remote;]>'),
    ],
    ['external DTD', withEntity('<!DOCTYPE samlp:Response SYSTEM "http://127.0.0.1:9/saml.dtd">')],
    [
      'nested entity expansion',
      withEntity(
        '<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY xxe "&b;&b;&b;&b;&b;&b;&b;&b;">]>',
      ),
    ],
    ['empty DOCTYPE without any entity', `<!DOCTYPE r>${valid()}`],
    ['undeclared entity reference', withEntity('')],
    [
      'processing instruction',
      `<?xml version="1.0"?><?xml-stylesheet href="http://127.0.0.1:9/x.xsl" type="text/xsl"?>${valid()}`,
    ],
    ['CDATA section', valid().replace('<samlp:Status>', '<samlp:Status><![CDATA[x]]>')],
    ['comment', valid().replace('<samlp:Status>', '<!-- note --><samlp:Status>')],
  ]

  it.each(cases)('refuses a document with: %s', (_name, document) => {
    // Refused on the text alone: no parser, and so no resolver of any kind, ever sees it.
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    const check = vi.spyOn(SignedXml.prototype, 'checkSignature')
    expect(rejection(document)).toBe('forbidden_markup')
    expect(parse).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
  })

  it('refuses a DOCTYPE hidden in a UTF-16 document and characters XML forbids', () => {
    const utf16 = Buffer.from(`﻿<!DOCTYPE r [<!ENTITY xxe "x">]>${valid()}`, 'utf16le')
    expect(() => verifySamlResponse(config, utf16.toString('base64'))).toThrowError(
      expect.objectContaining({
        reason: expect.stringMatching(/^(invalid_encoding|malformed_xml)$/),
      }),
    )
    expect(rejection(valid().replace('<samlp:Status>', '<samlp:Status>\u0000'))).toBe(
      'malformed_xml',
    )
    expect(rejection(valid().replace('<samlp:Status>', '<samlp:Status>&#0;'))).toBe('malformed_xml')
    expect(rejection(`<?xml version="1.0" encoding="UTF-7"?>${valid()}`)).toBe('forbidden_markup')
  })
})

describe('SAML negative corpus: external and unexpected signature references', () => {
  it('refuses a reference to an external resource', () => {
    for (const uri of ['https://evil.example/assertion.xml', 'file:///etc/passwd', 'evil.xml#a']) {
      const document = valid().replace('URI="#_assertion-a1"', `URI="${uri}"`)
      expect(document).toContain(`URI="${uri}"`)
      expect(rejection(document)).toBe('external_reference')
    }
  })

  it('refuses a validly signed whole-document reference and a reference without a URI', () => {
    const whole = responseXml({
      assertion: sign(assertionXml(), 'Assertion', { emptyUri: true }),
    })
    expect(whole).toContain('URI=""')
    expect(rejection(whole)).toBe('signature_reference_mismatch')
    expect(rejection(valid().replace(' URI="#_assertion-a1"', ''))).toBe(
      'signature_reference_mismatch',
    )
  })

  it('refuses a reference to another element of the same document', () => {
    const document = valid().replace('URI="#_assertion-a1"', 'URI="#_response-r1"')
    expect(rejection(document)).toBe('signature_reference_mismatch')
  })

  it('refuses a key fetched through RetrievalMethod and any second reference', () => {
    const retrieval = valid().replace(
      /<ds:KeyInfo>.*<\/ds:KeyInfo>/s,
      '<ds:KeyInfo><ds:RetrievalMethod URI="https://evil.example/key.pem"/></ds:KeyInfo>',
    )
    expect(retrieval).toContain('RetrievalMethod')
    expect(rejection(retrieval)).toBe('external_reference')
    const second = valid().replace(
      '</ds:Reference>',
      `</ds:Reference><ds:Reference URI="https://evil.example/x"><ds:DigestMethod Algorithm="${SHA256}"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>`,
    )
    expect(rejection(second)).toBe('unexpected_structure')
  })

  it('never trusts a certificate that only the incoming XML carries', () => {
    const selfVouched = responseXml({ assertion: signedAssertion(undefined, { by: attacker }) })
    expect(selfVouched).toContain(attacker.base64.slice(0, 64))
    expect(rejection(selfVouched)).toBe('signature_invalid')
    // The genuine certificate in KeyInfo over an attacker signature is no better.
    const relabelled = selfVouched.replace(
      /<ds:X509Certificate>[^<]+<\/ds:X509Certificate>/,
      `<ds:X509Certificate>${idp.base64}</ds:X509Certificate>`,
    )
    expect(rejection(relabelled)).toBe('signature_invalid')
  })
})

describe('SAML negative corpus: unsigned assertions and response-only signatures', () => {
  it('refuses a response with no signature at all', () => {
    expect(rejection(responseXml())).toBe('assertion_signature_required')
  })

  it('refuses a validly signed response whose assertion is not signed itself', () => {
    const responseOnly = sign(responseXml(), 'Response')
    // The response signature is genuine: the same document passes once the assertion is signed.
    expect(responseOnly.match(/<ds:Signature /g)).toHaveLength(1)
    expect(rejection(sign(valid(), 'Response'))).toBe('accepted')
    expect(rejection(responseOnly)).toBe('assertion_signature_required')
  })

  it('refuses a signed assertion altered after signing and an emptied signature value', () => {
    const altered = valid().replace(
      '>ada@acme.example</saml:NameID>',
      '>mallory@evil.example</saml:NameID>',
    )
    expect(altered).toContain('mallory@evil.example')
    expect(rejection(altered)).toBe('signature_invalid')
    const emptied = valid().replace(/<ds:SignatureValue>[^<]+</, '<ds:SignatureValue><')
    expect(rejection(emptied)).toBe('signature_invalid')
  })
})

describe('SAML negative corpus: SHA-1 and unconfigured algorithms', () => {
  // Every document here carries a signature that verifies under its declared algorithms.
  const cases: [string, SignOptions][] = [
    ['RSA-SHA1 signature', { signatureAlgorithm: RSA_SHA1 }],
    ['SHA-1 digest', { digestAlgorithm: SHA1 }],
    [
      'RSA-SHA1 signature over a SHA-1 digest',
      { signatureAlgorithm: RSA_SHA1, digestAlgorithm: SHA1 },
    ],
    ['RSA-SHA512 signature (not configured)', { signatureAlgorithm: RSA_SHA512 }],
    ['SHA-512 digest (not configured)', { digestAlgorithm: SHA512 }],
    ['inclusive canonicalization (not configured)', { canonicalization: C14N }],
    ['inclusive canonicalization transform only', { transforms: [ENVELOPED, C14N] }],
    ['no canonicalization transform', { transforms: [ENVELOPED] }],
  ]

  it.each(cases)('refuses a validly signed assertion using: %s', (_name, signing) => {
    // Signed in place: inclusive canonicalization depends on the enclosing response.
    const document = sign(responseXml(), 'Assertion', signing)
    // The library, left unrestricted, accepts this signature: only the allow-list refuses it.
    const unrestricted = new SignedXml({ publicCert: idp.pem })
    const signature = new DOMParser()
      .parseFromString(document, 'text/xml')
      .getElementsByTagName('ds:Signature')[0]
    unrestricted.loadSignature(signature ?? '')
    expect(unrestricted.checkSignature(document)).toBe(true)
    expect(rejection(document)).toBe('algorithm_not_allowed')
  })

  it('refuses an XPath transform', () => {
    const document = valid().replace(
      `<ds:Transform Algorithm="${ENVELOPED}"/>`,
      '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(ancestor-or-self::ds:Signature)</ds:XPath></ds:Transform>',
    )
    expect(document).toContain('REC-xpath')
    expect(rejection(document)).toBe('algorithm_not_allowed')
  })

  it('takes the allow-list from configuration and never lets it name SHA-1', () => {
    const allow = (algorithms: Partial<SamlVerifierConfig['algorithms']>) => ({
      ...config,
      algorithms: { ...samlInitialAlgorithms, ...algorithms },
    })
    expect(rejection(valid(), allow({ digest: [] }))).toBe('algorithm_not_allowed')
    expect(rejection(valid(), allow({ signature: [] }))).toBe('algorithm_not_allowed')
    expect(rejection(valid(), allow({ canonicalization: [] }))).toBe('algorithm_not_allowed')
    const sha1 = responseXml({
      assertion: signedAssertion(undefined, {
        signatureAlgorithm: RSA_SHA1,
        digestAlgorithm: SHA1,
      }),
    })
    for (const settings of [
      allow({ signature: [RSA_SHA256, RSA_SHA1] }),
      allow({ digest: [SHA256, SHA1] }),
      allow({ signature: [RSA_SHA512] }),
      allow({ canonicalization: [EXC_C14N, C14N] }),
    ])
      expect(rejection(sha1, settings)).toBe('invalid_configuration')
  })
})

describe('SAML negative corpus: audience, recipient and destination binding', () => {
  const audience = (...restrictions: string[][]) => ({
    conditions: restrictions
      .map(
        (names) =>
          `<saml:AudienceRestriction>${names.map((name) => `<saml:Audience>${name}</saml:Audience>`).join('')}</saml:AudienceRestriction>`,
      )
      .join(''),
  })

  it.each([
    ['another service provider', audience(['https://other.example.test/sp'])],
    ['a prefix of the entity ID', audience([SP.slice(0, -1)])],
    ['the entity ID with a trailing slash', audience([`${SP}/`])],
    ['the entity ID in another case', audience([SP.toUpperCase()])],
    [
      'one of two restrictions naming someone else',
      audience([SP], ['https://other.example.test/sp']),
    ],
    ['no audience restriction', { conditions: '' }],
    ['an empty audience restriction', audience([])],
  ])('refuses a validly signed assertion for: %s', (_name, options) => {
    expect(rejection(valid(options))).toBe('audience_mismatch')
  })

  it('accepts a restriction that lists this service provider among others', () => {
    const result = verifySamlResponse(
      config,
      encode(valid(audience(['https://other.example.test/sp', SP]))),
    )
    expect(result.assertion.audiences).toEqual(['https://other.example.test/sp', SP])
  })

  it.each([
    ['another ACS URL', 'https://hourmere.example.test/api/auth/sso/saml2/sp/acs/provider-b'],
    ['another host', ACS.replace('hourmere.example.test', 'evil.example')],
    ['a trailing slash', `${ACS}/`],
    ['a query string', `${ACS}?x=1`],
    ['no Recipient', null],
  ])('refuses a validly signed assertion whose bearer Recipient is: %s', (_name, recipient) => {
    expect(rejection(valid({ recipient }))).toBe('recipient_mismatch')
  })

  it.each([
    ['another ACS URL', 'https://hourmere.example.test/api/auth/sso/saml2/sp/acs/provider-b'],
    ['another host', ACS.replace('hourmere.example.test', 'evil.example')],
    ['a trailing slash', `${ACS}/`],
    ['no Destination', null],
  ])('refuses a response whose Destination is: %s', (_name, destination) => {
    expect(rejection(valid({}, { destination }))).toBe('destination_mismatch')
    // Signing the response does not make a wrong Destination acceptable.
    expect(rejection(sign(valid({}, { destination }), 'Response'))).toBe('destination_mismatch')
  })

  it('refuses another issuer, on the assertion or on the response', () => {
    expect(rejection(valid({ issuer: 'https://idp.example.test/realms/other' }))).toBe(
      'issuer_mismatch',
    )
    const wrapper = valid().replace(
      `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status>`,
      '<saml:Issuer>https://evil.example</saml:Issuer><samlp:Status>',
    )
    expect(wrapper).toContain('https://evil.example')
    expect(rejection(wrapper)).toBe('issuer_mismatch')
  })

  it('refuses a response and a subject confirmation that answer different requests', () => {
    expect(rejection(valid({ inResponseTo: '_request-other' }))).toBe('in_response_to_mismatch')
    expect(rejection(valid({}, { inResponseTo: '_request-other' }))).toBe('in_response_to_mismatch')
  })
})

describe('SAML negative corpus: encrypted input', () => {
  const encryptedData =
    '<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element"><xenc:EncryptionMethod Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"/><xenc:CipherData><xenc:CipherValue>AAAA</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData>'

  it('refuses an encrypted assertion, also beside a signed one and under a signed response', () => {
    const encrypted = `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encryptedData}</saml:EncryptedAssertion>`
    expect(rejection(responseXml({ assertion: encrypted }))).toBe('encrypted_unsupported')
    expect(rejection(sign(responseXml({ assertion: encrypted }), 'Response'))).toBe(
      'encrypted_unsupported',
    )
    expect(rejection(valid().replace('</samlp:Response>', `${encrypted}</samlp:Response>`))).toBe(
      'encrypted_unsupported',
    )
  })

  it('refuses a validly signed assertion with an encrypted NameID or attribute', () => {
    const encryptedId = valid({
      subject: `<saml:EncryptedID>${encryptedData}</saml:EncryptedID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${REQUEST}" Recipient="${ACS}"/></saml:SubjectConfirmation>`,
    })
    expect(rejection(encryptedId)).toBe('encrypted_unsupported')
    const encryptedAttribute = valid({
      statements: `<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z"/><saml:AttributeStatement><saml:EncryptedAttribute>${encryptedData}</saml:EncryptedAttribute></saml:AttributeStatement>`,
    })
    expect(rejection(encryptedAttribute)).toBe('encrypted_unsupported')
  })
})

describe('SAML negative corpus: structure, namespaces and input limits', () => {
  it('refuses two assertions even when both are validly signed', () => {
    const second = signedAssertion({ id: '_assertion-a2', nameId: 'grace@acme.example' })
    expect(rejection(valid().replace('</samlp:Response>', `${second}</samlp:Response>`))).toBe(
      'multiple_assertions',
    )
  })

  it('refuses a validly signed assertion with an ambiguous attribute', () => {
    const attribute = (value: string) =>
      `<saml:Attribute Name="email"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`
    const authn = '<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z"/>'
    const sameStatement = `${authn}<saml:AttributeStatement>${attribute('ada@acme.example')}${attribute('mallory@evil.example')}</saml:AttributeStatement>`
    const twoStatements = `${authn}<saml:AttributeStatement>${attribute('ada@acme.example')}</saml:AttributeStatement><saml:AttributeStatement>${attribute('mallory@evil.example')}</saml:AttributeStatement>`
    expect(rejection(valid({ statements: sameStatement }))).toBe('ambiguous_attribute')
    expect(rejection(valid({ statements: twoStatements }))).toBe('ambiguous_attribute')
    const nested = `${authn}<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue><saml:NameID>mallory@evil.example</saml:NameID></saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    expect(rejection(valid({ statements: nested }))).toBe('unexpected_structure')
  })

  it('refuses a validly signed assertion with an ambiguous subject', () => {
    const confirmation = `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${REQUEST}" Recipient="${ACS}"/></saml:SubjectConfirmation>`
    const nameId = (value: string) => `<saml:NameID>${value}</saml:NameID>`
    for (const subject of [
      nameId('ada@acme.example') + nameId('mallory@evil.example') + confirmation,
      nameId('ada@acme.example') + confirmation + confirmation,
      nameId('ada@acme.example'),
      confirmation,
      nameId(' ') + confirmation,
      nameId('ada@acme.example') + confirmation.replace('cm:bearer', 'cm:holder-of-key'),
    ])
      expect(rejection(valid({ subject }))).toBe('unexpected_structure')
  })

  it('refuses unexpected namespaces, on elements and on attributes', () => {
    const foreign = valid({
      statements:
        '<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z"/><x:Role xmlns:x="urn:example:roles">owner</x:Role>',
    })
    expect(rejection(foreign)).toBe('unexpected_namespace')
    const lookalike = valid().replace(
      'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
      'xmlns:samlp="urn:oasis:names:tc:SAML:1.1:protocol"',
    )
    expect(rejection(lookalike)).toBe('unexpected_namespace')
    const qualified = valid().replace(
      '<samlp:Status>',
      '<samlp:Status xml:base="https://evil.example/">',
    )
    expect(rejection(qualified)).toBe('unexpected_namespace')
    const unknownCondition = valid({
      conditions: `<saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction><saml:Condition/>`,
    })
    expect(rejection(unknownCondition)).toBe('unexpected_structure')
  })

  it('refuses a response that does not report success', () => {
    const failed = valid(
      {},
      { status: '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"/>' },
    )
    expect(rejection(failed)).toBe('status_not_success')
    const partial = valid(
      {},
      {
        status:
          '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:PartialLogout"/></samlp:StatusCode>',
      },
    )
    expect(rejection(partial)).toBe('status_not_success')
  })

  it('refuses input that is not the expected encoding, shape or size', () => {
    const reason = (input: unknown) => {
      try {
        verifySamlResponse(config, input)
        return 'accepted'
      } catch (error) {
        return (error as SamlVerificationError).reason
      }
    }
    expect(reason(undefined)).toBe('invalid_encoding')
    expect(reason('')).toBe('invalid_encoding')
    expect(reason(valid())).toBe('invalid_encoding')
    expect(reason(`${encode(valid())}*`)).toBe('invalid_encoding')
    expect(reason(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'))).toBe('invalid_encoding')
    expect(reason(encode('not xml'))).toBe('malformed_xml')
    expect(reason(encode('<samlp:Response>'))).toBe('malformed_xml')
    expect(reason(encode(`${valid()}${valid()}`))).toBe('malformed_xml')
    expect(reason(encode(assertionXml()))).toBe('unexpected_structure')
    const padded = valid().replace(
      '<samlp:Status>',
      `<samlp:Status>${' '.repeat(samlMaximumResponseBytes)}`,
    )
    expect(reason(encode(padded))).toBe('too_large')
    const deep = valid().replace(
      '<samlp:StatusCode',
      `${'<samlp:StatusDetail>'.repeat(40)}${'</samlp:StatusDetail>'.repeat(40)}<samlp:StatusCode`,
    )
    expect(reason(encode(deep))).toBe('too_large')
  })

  it('refuses unusable configuration before reading any input', () => {
    const weak = identity('weak.example.test', 1024)
    const settings: Partial<SamlVerifierConfig>[] = [
      { signingCertificates: [] },
      { signingCertificates: ['not a certificate'] },
      { signingCertificates: [weak.pem] },
      { signingCertificates: [idp.pem, idp.pem, idp.pem, idp.pem, idp.pem] },
      { idpEntityId: '' },
      { spEntityId: ' ' },
      { acsUrl: '' },
    ]
    for (const override of settings)
      expect(rejection(valid(), { ...config, ...override })).toBe('invalid_configuration')
  })
})

describe('SAML verifier: review hardening', () => {
  const elapsed = (run: () => void) => {
    const start = performance.now()
    run()
    return performance.now() - start
  }

  it('refuses long white space runs quickly instead of stalling on them', () => {
    const spaces = ' '.repeat(250_000)
    let reason: string | undefined
    expect(
      elapsed(() => {
        reason = rejection(`<a>${spaces}x</a>`)
      }),
    ).toBeLessThan(500)
    expect(reason).toBe('too_large')
    // A validly signed response padded in its unsigned wrapper, in the middle or at either end.
    for (const padded of [
      valid().replace('<samlp:Status>', `<samlp:Status>${' '.repeat(240_000)}`),
      `${' '.repeat(240_000)}${valid()}`,
      `${valid()}${'\n'.repeat(240_000)}`,
    ]) {
      expect(elapsed(() => (reason = rejection(padded)))).toBeLessThan(500)
      expect(reason).toBe('too_large')
    }
    // Ordinary indentation, also a generous amount of it, is accepted and fast.
    const indented = valid().replace('<samlp:Status>', `${' '.repeat(4_096)}<samlp:Status>`)
    expect(elapsed(() => (reason = rejection(indented)))).toBeLessThan(500)
    expect(reason).toBe('accepted')
    // Other pathological text is refused quickly too.
    for (const hostile of [
      `<a>${'&'.repeat(200_000)}</a>`,
      `<a>${'&#'.repeat(100_000)}</a>`,
      `<?xml version="1.0"${' \n'.repeat(100_000)}x?><a/>`,
      `<a ${'b '.repeat(100_000)}/>`,
    ])
      expect(elapsed(() => rejection(hostile))).toBeLessThan(500)
    const base64Padding = `${' \r\n'.repeat(150_000)}${encode(valid())}`
    expect(elapsed(() => verifySamlResponse(config, base64Padding))).toBeLessThan(500)
  })

  it('ignores KeyName and KeyValue in KeyInfo and still refuses RetrievalMethod', () => {
    // KeyInfo is outside SignedInfo, so adding to it leaves the signature valid.
    const keycloakStyle = valid()
      .replace('<ds:KeyInfo>', '<ds:KeyInfo><ds:KeyName>idp-signing-key-1</ds:KeyName>')
      .replace(
        '</ds:KeyInfo>',
        '<ds:KeyValue><ds:RSAKeyValue><ds:Modulus>AQAB</ds:Modulus><ds:Exponent>AQAB</ds:Exponent></ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo>',
      )
    expect(keycloakStyle).toContain('<ds:KeyName>')
    expect(keycloakStyle).toContain('<ds:KeyValue>')
    expect(rejection(keycloakStyle)).toBe('accepted')
    // The attacker's own public key in KeyValue is not a source of trust.
    const forgedKey = responseXml({
      assertion: signedAssertion(undefined, { by: attacker }),
    }).replace(
      '</ds:KeyInfo>',
      '<ds:KeyValue><ds:RSAKeyValue><ds:Modulus>AQAB</ds:Modulus><ds:Exponent>AQAB</ds:Exponent></ds:RSAKeyValue></ds:KeyValue></ds:KeyInfo>',
    )
    expect(rejection(forgedKey)).toBe('signature_invalid')
    const withRetrieval = keycloakStyle.replace(
      '</ds:KeyInfo>',
      '<ds:RetrievalMethod URI="https://evil.example/key.pem"/></ds:KeyInfo>',
    )
    expect(rejection(withRetrieval)).toBe('external_reference')
    const unknown = valid().replace('</ds:KeyInfo>', '<ds:MgmtData>x</ds:MgmtData></ds:KeyInfo>')
    expect(rejection(unknown)).toBe('unexpected_structure')
  })

  it('accepts the usual XML declarations and one UTF-8 byte order mark, nothing wider', () => {
    for (const declaration of [
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      "<?xml version='1.0' encoding='utf-8'?>",
      "<?xml version='1.0' standalone='no' ?>",
      '<?xml version = "1.0" encoding = "UTF-8"?>\n',
      '﻿<?xml version="1.0" encoding="UTF-8"?>',
      '﻿',
    ])
      expect(rejection(`${declaration}${valid()}`)).toBe('accepted')
    for (const declaration of [
      '<?xml version="1.1"?>',
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<?xml version="1.0" encoding="ISO-8859-1"?>',
      '<?xml version="1.0" standalone="maybe"?>',
      '<?xml version="1.0" encoding="UTF-8"?><?xml version="1.0"?>',
      '<?xml version="1.0"?><?pi x?>',
      ' <?xml version="1.0"?>',
      '<?xml-stylesheet href="x"?>',
    ])
      expect(rejection(`${declaration}${valid()}`)).toBe('forbidden_markup')
    // A second byte order mark is text before the root element.
    expect(rejection(`﻿﻿${valid()}`)).toBe('malformed_xml')
    // The mark is accepted as real UTF-8 bytes as well.
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid(), 'utf8')])
    expect(verifySamlResponse(config, bytes.toString('base64')).assertion.id).toBe('_assertion-a1')
  })

  it('returns attributes without inherited names', () => {
    const statements = `<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z"/><saml:AttributeStatement>${[
      'email',
      '__proto__',
      'constructor',
      'hasOwnProperty',
    ]
      .map(
        (name) =>
          `<saml:Attribute Name="${name}"><saml:AttributeValue>${name}-value</saml:AttributeValue></saml:Attribute>`,
      )
      .join('')}</saml:AttributeStatement>`
    const { attributes } = verifySamlResponse(config, encode(valid({ statements }))).assertion
    expect(Object.getPrototypeOf(attributes)).toBeNull()
    expect(Object.keys(attributes)).toEqual(['email', '__proto__', 'constructor', 'hasOwnProperty'])
    expect(attributes.constructor).toEqual(['constructor-value'])
    expect(Reflect.get(attributes, '__proto__')).toEqual(['__proto__-value'])
    const plain = verifySamlResponse(config, encode(valid())).assertion.attributes
    expect(plain.constructor).toBeUndefined()
    expect(plain.toString).toBeUndefined()
    expect(Reflect.get(plain, '__proto__')).toBeUndefined()
  })

  it('refuses a namespace prefix named like an ID attribute', () => {
    for (const name of ['ID', 'Id', 'id']) {
      const document = valid().replace(
        '<samlp:Status>',
        `<samlp:Status xmlns:${name}="_assertion-a1">`,
      )
      expect(rejection(document)).toBe('unexpected_structure')
    }
  })

  it('binds an InclusiveNamespaces prefix list and the ancestor declarations it pulls in', () => {
    const withPrefix = responseXml().replace(
      '<samlp:Response ',
      '<samlp:Response xmlns:xs="http://www.w3.org/2001/XMLSchema" ',
    )
    const document = sign(withPrefix, 'Assertion', { inclusivePrefixes: ['xs'] })
    expect(document).toContain('PrefixList="xs"')
    expect(rejection(document)).toBe('accepted')
    // The signed bytes include the ancestor's declaration: rebinding the prefix breaks them.
    const rebound = document.replace(
      'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
      'xmlns:xs="urn:evil:schema"',
    )
    expect(rebound).not.toBe(document)
    expect(rejection(rebound)).toBe('signature_invalid')
    // A prefix list injected after signing, or changed, is covered by the signature as well.
    const injected = valid().replace(
      `<ds:Transform Algorithm="${EXC_C14N}"/>`,
      `<ds:Transform Algorithm="${EXC_C14N}"><ec:InclusiveNamespaces xmlns:ec="${EXC_C14N}" PrefixList="samlp"/></ds:Transform>`,
    )
    expect(injected).toContain('PrefixList="samlp"')
    expect(rejection(injected)).toBe('signature_invalid')
    expect(rejection(document.replace('PrefixList="xs"', 'PrefixList="xs samlp"'))).toBe(
      'signature_invalid',
    )
  })

  it('refuses a response-signed document whose assertion was altered afterwards', () => {
    const both = sign(valid(), 'Response')
    const altered = both.replace(
      '>ada@acme.example</saml:NameID>',
      '>mallory@evil.example</saml:NameID>',
    )
    expect(altered).not.toBe(both)
    expect(rejection(altered)).toBe('signature_invalid')
    // Re-signing only the assertion with another key under the genuine response signature.
    const { before, after } = parts(both)
    const resigned =
      before + signedAssertion({ nameId: 'mallory@evil.example' }, { by: attacker }) + after
    expect(rejection(resigned)).toBe('signature_invalid')
  })

  it('passes absent time bounds through as null for the timing step to refuse', () => {
    const { assertion } = verifySamlResponse(
      config,
      encode(valid({ conditionsAttributes: '', confirmationNotOnOrAfter: null })),
    )
    expect(assertion.conditions).toEqual({ notBefore: null, notOnOrAfter: null })
    expect(assertion.subjectConfirmation.notBefore).toBeNull()
    expect(assertion.subjectConfirmation.notOnOrAfter).toBeNull()
  })

  it('returns NameID and attribute values exactly as signed, untrimmed', () => {
    const statements =
      '<saml:AuthnStatement AuthnInstant="2026-06-12T11:59:58Z"/><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue> Ada@Acme.example\n</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>'
    const { assertion } = verifySamlResponse(
      config,
      encode(valid({ nameId: ' Ada@Acme.example ', statements })),
    )
    expect(assertion.nameId.value).toBe(' Ada@Acme.example ')
    expect(assertion.attributes.email).toEqual([' Ada@Acme.example\n'])
  })
})

describe('SAML verifier: runtime callers', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const verifier = 'apps/server/src/sso-saml-verifier.ts'
  const acs = 'apps/server/src/sso-saml-sign-in.ts'

  function productionSources() {
    const files: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
          files.push(relative(root, path))
      }
    }
    for (const group of ['apps', 'packages', 'tools'])
      for (const name of readdirSync(join(root, group))) {
        const source = join(root, group, name, 'src')
        if (statSync(source, { throwIfNoEntry: false })?.isDirectory()) walk(source)
      }
    return files
  }

  it('allows only the ACS to use the SAML verifier and limits XML library imports', () => {
    const files = productionSources()
    expect(files).toEqual(
      expect.arrayContaining([verifier, 'apps/server/src/server.ts', 'tools/cli/src/cli.ts']),
    )
    const mention =
      /sso-saml-verifier|verifySamlResponse|SamlVerificationError|samlInitialAlgorithms|(['"`])(?:xml-crypto|@xmldom\/xmldom|samlify)(?:\/[^'"`]*)?\1/
    const xmlLibrary = /(['"`])(?:xml-crypto|@xmldom\/xmldom|samlify)(?:\/[^'"`]*)?\1/
    expect(mention.test(readFileSync(join(root, acs), 'utf8'))).toBe(true)
    expect(xmlLibrary.test(readFileSync(join(root, acs), 'utf8'))).toBe(false)
    const mentioning = files.filter((file) => {
      if (file === acs) return false
      const source = readFileSync(join(root, file), 'utf8')
      let runtime = source
      if (file === 'apps/server/src/sso-saml-replay.ts')
        runtime = source.replace(
          /^import type \{ VerifiedSamlResponse \} from '\.\/sso-saml-verifier\.ts'$/m,
          '',
        )
      if (file === 'apps/server/src/sso-saml-start.ts')
        runtime = source
          .replace(/^import \{ DOMImplementation, XMLSerializer \} from '@xmldom\/xmldom'$/m, '')
          .replace(
            /^import \{ Constants, IdentityProvider, ServiceProvider \} from 'samlify'$/m,
            '',
          )
      return mention.test(runtime)
    })
    expect(mentioning).toEqual([verifier])
    // The pattern does catch an import, a re-export and a dynamic import.
    for (const line of [
      "import { verifySamlResponse } from './sso-saml-verifier.ts'",
      "export * from './sso-saml-verifier.ts'",
      "const { SignedXml } = await import('xml-crypto')",
      "import { DOMParser } from '@xmldom/xmldom'",
      'import * as saml from "samlify"',
    ])
      expect(mention.test(line)).toBe(true)
  })
})

const issued = Temporal.Instant.from('2026-06-12T12:00:00Z')
const conditionsTimes = (notBefore: string | null, notOnOrAfter: string | null) =>
  `${notBefore === null ? '' : ` NotBefore="${notBefore}"`}${notOnOrAfter === null ? '' : ` NotOnOrAfter="${notOnOrAfter}"`}`

describe('SAML timing and replay: signed time bounds', () => {
  const before = issued.subtract({ seconds: 60 }).toString()
  const after = issued.add({ seconds: 300 }).toString()

  it.each<{ label: string; options: AssertionOptions }>([
    {
      label: 'missing Conditions NotBefore',
      options: { conditionsAttributes: conditionsTimes(null, after) },
    },
    {
      label: 'infinite Conditions NotBefore',
      options: { conditionsAttributes: conditionsTimes('-infinity', after) },
    },
    {
      label: 'missing Conditions NotOnOrAfter',
      options: { conditionsAttributes: conditionsTimes(before, null) },
    },
    {
      label: 'infinite Conditions NotOnOrAfter',
      options: { conditionsAttributes: conditionsTimes(before, 'infinity') },
    },
    { label: 'missing bearer NotOnOrAfter', options: { confirmationNotOnOrAfter: null } },
    { label: 'infinite bearer NotOnOrAfter', options: { confirmationNotOnOrAfter: 'infinity' } },
    { label: 'infinite IssueInstant', options: { issueInstant: 'infinity' } },
    { label: 'invalid calendar date', options: { issueInstant: '2026-06-31T12:00:00Z' } },
    { label: 'timestamp without timezone', options: { issueInstant: '2026-06-12T12:00:00' } },
  ])('refuses $label after signature validation', ({ options }) => {
    const { assertion } = verifySamlResponse(config, encode(valid(options)))
    expect(() => validateSamlTiming(assertion, issued)).toThrow(SamlTimingError)
  })

  it('refuses a signed assertion missing IssueInstant at the verifier boundary', () => {
    expect(() => verifySamlResponse(config, encode(valid({ issueInstant: null })))).toThrow(
      expect.objectContaining({ reason: 'unexpected_structure' }),
    )
  })

  it.each([
    {
      label: 'Entra: 70-minute Conditions, 5-minute bearer',
      conditionsSeconds: 4_200,
      bearerSeconds: 300,
      deadlineSeconds: 300,
    },
    {
      label: 'AD FS: 60-minute Conditions and long bearer',
      conditionsSeconds: 3_600,
      bearerSeconds: 3_600,
      deadlineSeconds: 600,
    },
    {
      label: 'Conditions expire first',
      conditionsSeconds: 180,
      bearerSeconds: 300,
      deadlineSeconds: 180,
    },
  ])(
    'uses the earliest deadline for $label',
    ({ conditionsSeconds, bearerSeconds, deadlineSeconds }) => {
      // The unsigned response IssueInstant cannot choose the clock window.
      const xml = valid({
        conditionsAttributes: conditionsTimes(
          issued.toString(),
          issued.add({ seconds: conditionsSeconds }).toString(),
        ),
        confirmationNotOnOrAfter: issued.add({ seconds: bearerSeconds }).toString(),
      }).replace('IssueInstant="2026-06-12T12:00:01Z"', 'IssueInstant="infinity"')
      const { assertion } = verifySamlResponse(config, encode(xml))
      const deadline = issued.add({ seconds: deadlineSeconds })
      const expiry = deadline.add({ seconds: 60 })
      expect(
        validateSamlTiming(assertion, deadline.subtract({ nanoseconds: 1 })).epochNanoseconds,
      ).toBe(deadline.epochNanoseconds)
      expect(
        validateSamlTiming(assertion, expiry.subtract({ nanoseconds: 1 })).epochNanoseconds,
      ).toBe(deadline.epochNanoseconds)
      expect(() => validateSamlTiming(assertion, expiry)).toThrow(SamlTimingError)
      expect(() => validateSamlTiming(assertion, expiry.add({ nanoseconds: 1 }))).toThrow(
        SamlTimingError,
      )
    },
  )

  const future = issued.add({ seconds: 60 }).toString()

  it.each<{ label: string; options: AssertionOptions }>([
    {
      label: 'Conditions NotBefore',
      options: { conditionsAttributes: conditionsTimes(future, after) },
    },
    { label: 'bearer NotBefore', options: { confirmationNotBefore: future } },
    { label: 'IssueInstant', options: { issueInstant: future } },
  ])('allows exactly 60 seconds of future skew for $label', ({ options }) => {
    const { assertion } = verifySamlResponse(config, encode(valid(options)))
    expect(validateSamlTiming(assertion, issued).epochNanoseconds).toBe(
      issued.add({ seconds: 300 }).epochNanoseconds,
    )
    expect(() => validateSamlTiming(assertion, issued.subtract({ nanoseconds: 1 }))).toThrow(
      SamlTimingError,
    )
  })
})

const databaseUrl = process.env.DATABASE_URL
const replayDigest = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!databaseUrl)('SAML timing and replay: database', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  let providerId: string
  let otherProviderId: string

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'saml_replay' })
    db = createDb(owned.pool)
    const seed = await owned.pool.connect()
    let fixture: Awaited<ReturnType<typeof ssoFixture>>
    try {
      fixture = await ssoFixture(seed)
    } finally {
      seed.release()
    }
    organizationId = fixture.team
    providerId = (
      await db
        .insertInto('sso_providers')
        .values({ ...samlProviderValues(organizationId), issuer: IDP })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    otherProviderId = (
      await db
        .insertInto('sso_providers')
        .values(samlProviderValues(fixture.otherTeam))
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function inputs(requestLifetime = 540) {
    // Use the same wall clock as expiry in Postgres, even under the JS clock-offset suite.
    const { now } = await db
      .selectNoFrom(
        sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'now',
        ),
      )
      .executeTakeFirstOrThrow()
    const issueInstant = Temporal.Instant.from(now)
    const deadline = issueInstant.add({ seconds: 300 })
    const request = {
      id: `_request-${randomUUID()}`,
      organizationId,
      providerId,
      expiresAt: issueInstant.add({ seconds: requestLifetime }),
    }
    return { deadline, request, issueInstant }
  }

  function signedResult(
    input: Awaited<ReturnType<typeof inputs>>,
    assertionId = `_assertion-${randomUUID()}`,
    responseId = `_response-${randomUUID()}`,
    signResponse = false,
  ) {
    const { request, issueInstant, deadline } = input
    const xml = valid(
      {
        id: assertionId,
        inResponseTo: request.id,
        issueInstant: issueInstant.toString(),
        conditionsAttributes: conditionsTimes(
          issueInstant.toString(),
          issueInstant.add({ seconds: 4_200 }).toString(),
        ),
        confirmationNotOnOrAfter: deadline.toString(),
      },
      { id: responseId, inResponseTo: request.id },
    )
    return verifySamlResponse(config, encode(signResponse ? sign(xml, 'Response') : xml))
  }

  async function retainedFor(keys: string[]) {
    return db
      .selectFrom('sso_replay_cache')
      .select([
        'kind',
        'key_digest',
        sql<string>`to_char(retain_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'retention',
        ),
      ])
      .where('provider_id', '=', providerId)
      .where('key_digest', 'in', keys.map(replayDigest))
      .execute()
  }

  it('refuses an expired request, an unmatched ID and a different provider without writing', async () => {
    const live = await inputs()
    const verified = signedResult(live)
    await expect(
      consumeSamlReplay(
        db,
        verified,
        { ...live.request, expiresAt: live.issueInstant },
        providerId,
      ),
    ).rejects.toMatchObject({ reason: 'request_expired' })
    await expect(
      consumeSamlReplay(db, verified, { ...live.request, id: '_other-request' }, providerId),
    ).rejects.toMatchObject({ reason: 'request_mismatch' })
    await expect(
      consumeSamlReplay(db, verified, live.request, otherProviderId),
    ).rejects.toMatchObject({ reason: 'request_mismatch' })
    expect(
      await retainedFor([live.request.id, verified.assertion.id, verified.response.id]),
    ).toEqual([])
    expect((await consumeSamlReplay(db, verified, live.request, providerId)).epochNanoseconds).toBe(
      live.deadline.epochNanoseconds,
    )
  })

  const backend = (conn: Db) =>
    conn.selectNoFrom(sql<number>`pg_backend_pid()`.as('pid')).executeTakeFirstOrThrow()

  it('rechecks expiry after a database lock wait and rolls back the consumed keys', async () => {
    const blocker = await owned.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE sso_replay_cache IN SHARE MODE')
      const input = await inputs(2)
      const verified = signedResult(input)
      await db.connection().execute(async (conn) => {
        const { pid } = await backend(conn)
        const outcome = Promise.allSettled([
          consumeSamlReplay(conn, verified, input.request, providerId),
        ])
        try {
          await expect
            .poll(async () => {
              const { rows } = await blocker.query<{ blocked: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                [pid],
              )
              return rows[0]?.blocked
            })
            .toBe(true)
          await blocker.query('SELECT pg_sleep_until($1::timestamptz)', [
            input.request.expiresAt.toString(),
          ])
        } finally {
          await blocker.query('ROLLBACK')
          await outcome
        }
        expect(await outcome).toMatchObject([
          { status: 'rejected', reason: { reason: 'request_expired' } },
        ])
      })
      expect(await retainedFor([input.request.id, verified.assertion.id])).toEqual([])
    } finally {
      blocker.release(true)
    }
  })

  it('commits only one of two concurrent callbacks with the same signed assertion ID', async () => {
    const left = await inputs()
    const right = await inputs()
    const sharedAssertion = `_assertion-${randomUUID()}`
    const leftResponse = signedResult(left, sharedAssertion)
    const rightResponse = signedResult(right, sharedAssertion)

    // Both callbacks have their own valid signed request correlation. The assertion ID is
    // the only shared key, so a conflict on the request key cannot make this test pass.
    const outcomes = await db.connection().execute((conn1) =>
      db.connection().execute(async (conn2) => {
        expect((await backend(conn1)).pid).not.toBe((await backend(conn2)).pid)
        return Promise.allSettled([
          consumeSamlReplay(conn1, leftResponse, left.request, providerId),
          consumeSamlReplay(conn2, rightResponse, right.request, providerId),
        ])
      }),
    )

    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({ reason: 'replay' }),
        }),
      ]),
    )
    const loser = outcomes[0].status === 'rejected' ? left : right
    const winner = loser === left ? right : left
    expect(await retainedFor([left.request.id, right.request.id, sharedAssertion])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'saml_request',
          key_digest: replayDigest(winner.request.id),
        }),
        expect.objectContaining({
          kind: 'saml_assertion',
          key_digest: replayDigest(sharedAssertion),
        }),
      ]),
    )
    expect(await retainedFor([loser.request.id])).toEqual([])
    await expect(
      consumeSamlReplay(db, signedResult(loser), loser.request, providerId),
    ).resolves.toEqual(loser.deadline)
  })

  it('consumes the request and a signed response ID independently of the assertion ID', async () => {
    const first = await inputs()
    const verified = signedResult(first, undefined, undefined, true)
    await consumeSamlReplay(db, verified, first.request, providerId)
    await expect(
      consumeSamlReplay(db, signedResult(first), first.request, providerId),
    ).rejects.toMatchObject({ reason: 'replay' })

    const second = await inputs()
    const sameResponse = signedResult(second, undefined, verified.response.id, true)
    await expect(
      consumeSamlReplay(db, sameResponse, second.request, providerId),
    ).rejects.toMatchObject({ reason: 'replay' })
    expect(await retainedFor([second.request.id, sameResponse.assertion.id])).toEqual([])
    // The same wrapper ID without a response signature cannot reserve or consume a key.
    await expect(
      consumeSamlReplay(
        db,
        signedResult(second, undefined, verified.response.id),
        second.request,
        providerId,
      ),
    ).resolves.toEqual(second.deadline)
  })

  it.each([100, 540])(
    'retains every consumed key through both time windows (request lifetime %s seconds)',
    async (requestLifetime) => {
      const input = await inputs(requestLifetime)
      const verified = signedResult(input, undefined, undefined, true)
      await consumeSamlReplay(db, verified, input.request, providerId)
      const rows = await retainedFor([
        input.request.id,
        verified.assertion.id,
        verified.response.id,
      ])
      expect(rows.map(({ kind }) => kind).sort()).toEqual([
        'saml_assertion',
        'saml_request',
        'saml_response',
      ])
      const expected =
        requestLifetime === 100 ? input.deadline.add({ seconds: 60 }) : input.request.expiresAt
      for (const { retention } of rows)
        expect(Temporal.Instant.from(retention).epochNanoseconds).toBe(expected.epochNanoseconds)
    },
  )

  it('rounds replay retention up to the database precision', async () => {
    const input = await inputs(100)
    const deadline = input.deadline.add({ nanoseconds: 1 })
    const verified = signedResult({ ...input, deadline })
    expect(
      (await consumeSamlReplay(db, verified, input.request, providerId)).epochNanoseconds,
    ).toBe(deadline.epochNanoseconds)
    const expected = input.deadline.add({ seconds: 60, microseconds: 1 })
    const rows = await retainedFor([input.request.id, verified.assertion.id])
    expect(rows).toHaveLength(2)
    for (const { retention } of rows)
      expect(Temporal.Instant.from(retention).epochNanoseconds).toBe(expected.epochNanoseconds)
  })

  it('purges expired rows in bounded batches while retaining live entries', async () => {
    const live = await inputs()
    const verified = signedResult(live)
    await consumeSamlReplay(db, verified, live.request, providerId)
    const expiredIds = [`_old-${randomUUID()}`, `_old-${randomUUID()}`]
    // Insert historical rows without the insert-time guard that rightly refuses expired writes.
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      await trx
        .insertInto('sso_replay_cache')
        .values(
          expiredIds.map((id) => ({
            organization_id: organizationId,
            provider_id: providerId,
            kind: 'saml_assertion',
            key_digest: replayDigest(id),
            consumed_at: sql<string>`clock_timestamp() - interval '180 seconds'`,
            retain_until: sql<string>`clock_timestamp() - interval '60 seconds'`,
          })),
        )
        .execute()
    })
    expect(await retainedFor(expiredIds)).toHaveLength(2)
    expect(await purgeExpiredSamlReplay(db, 1)).toBe(1)
    expect(await retainedFor(expiredIds)).toHaveLength(1)
    expect(await purgeExpiredSamlReplay(db, 1)).toBe(1)
    expect(await retainedFor(expiredIds)).toHaveLength(0)
    expect(await purgeExpiredSamlReplay(db, 1)).toBe(0)
    expect(
      await retainedFor([live.request.id, verified.assertion.id, verified.response.id]),
    ).toHaveLength(2)
  })
})
