// Every constraint, index, trigger and trigger rule of migration 0075, each with a check that
// passes on the migration as written and the source-copy mutations that remove or weaken it.
// sso-identity.test.ts runs every check against the real schema and requires the table to
// name every object the migration creates; sso-identity-mutations.test.ts applies each
// mutation to the predecessor schema and requires its check to fail; and
// sso-identity-coverage.test.ts drops each object through checkConstraintCoverage.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import {
  apiKey,
  bindingValues,
  DAY,
  freshProofValues,
  HOUR,
  type IdentityFixture,
  type IdentityTable,
  identityFixture,
  link,
  linkAttemptValues,
  linkValues,
  mailboxOf,
  oauthGrant,
  proofValues,
  proveMailbox,
  type Row,
  replayValues,
  seeded,
  session,
  signInValues,
  testValues,
  tokenValues,
  tried,
  triedInsert,
  triedUpdate,
} from './sso-identity-fixtures.ts'
import { checkLinkIdentityRace, checkReplayRace } from './sso-identity-races.ts'
import {
  accepted,
  at,
  claimedDomainValues,
  count,
  digest,
  inRolledBackTransaction,
  insert,
  insertAccepted,
  insertRefused,
  lapsedDomainValues,
  oidcProviderValues,
  pendingDomainValues,
  refused,
  sealed,
  updateRefused,
} from './sso-storage-fixtures.ts'
import {
  append,
  dropConstraint,
  dropIndex,
  dropTrigger,
  duplicate,
  edit,
  editFunction,
  replaceOnce,
  type SsoMutant,
  violation,
} from './sso-storage-protections.ts'

export interface IdentityProtection {
  /** Catalog objects (constraints, indexes, triggers) and trigger rules it covers. */
  objects: string[]
  check: (f: IdentityFixture) => Promise<void>
  mutants: SsoMutant[]
}

const foreignKey = (constraint: string) => ({ code: '23503', constraint })
const withoutTriggers = { withoutTriggers: true }

/** Replaces the RAISE statement that names `rule` with a no-op. */
const silence = (rule: string): SsoMutant => ({
  name: `${rule} never raised`,
  apply: (source) => {
    const pattern = new RegExp(
      `RAISE EXCEPTION '(?:[^']|'')*'\\s+USING ERRCODE = 'check_violation', CONSTRAINT = '${rule}';`,
      'g',
    )
    const matches = source.match(pattern) ?? []
    if (matches.length !== 1)
      throw new Error(`Expected one raise of ${rule}, found ${matches.length}`)
    return source.replace(pattern, 'NULL;')
  },
})
/** Several replacements, each of exactly one occurrence. */
const edits = (name: string, replacements: [string, string][]): SsoMutant => ({
  name,
  apply: (source) =>
    replacements.reduce(
      (text, [search, replacement]) => replaceOnce(text, search, replacement),
      source,
    ),
})

const links = 'sso_identity_links'
const attempts = 'sso_attempts'
const tokens = 'sso_mailbox_tokens'
const replay = 'sso_replay_cache'
const proofs = 'sso_browser_proofs'
const bindings = 'sso_delegation_bindings'
const byId = (row: Row) => ({ id: row.id })
const byDigest = (row: Row) => ({ token_digest: row.token_digest })

const retire = async (f: IdentityFixture, row: Row) =>
  (
    await f.db.query<Row>(
      `UPDATE sso_identity_links SET retired_at=now(), generation=generation+1
      WHERE id=$1 RETURNING *`,
      [row.id],
    )
  ).rows[0] as Row
const provider = (f: IdentityFixture, values: Row = {}) =>
  insert(f.db, 'sso_providers', { ...oidcProviderValues(f.team), enabled: true, ...values })
/** A claim of the team that `providerRow` serves. */
const servedDomain = async (f: IdentityFixture, values: Row, providerRow: Row = f.provider) => {
  const domain = await insert(f.db, 'sso_domains', values)
  await insert(f.db, 'sso_provider_domains', {
    organization_id: f.team,
    provider_id: providerRow.id,
    domain_id: domain.id,
  })
  return domain
}
const otherTeamFreshProof = (f: IdentityFixture): Row => ({
  ...freshProofValues(f),
  organization_id: f.otherTeam,
  user_id: f.otherOwner,
  session_id: f.sessions[f.otherOwner],
})
const stepUp = (
  linkRow: Row,
  authenticated = at(-5),
  expires = at(240),
  trustGeneration = 1,
): Row => ({
  step_up_provider_id: linkRow.provider_id,
  step_up_link_id: linkRow.id,
  step_up_authenticated_at: authenticated,
  step_up_proof_expires_at: expires,
  step_up_trust_generation: trustGeneration,
})
/** Records a step-up on an attempt. */
const recordStepUp = (f: IdentityFixture, attempt: Row, linkRow: Row) =>
  f.db.query(
    `UPDATE sso_attempts SET step_up_provider_id=$2, step_up_link_id=$3, step_up_authenticated_at=$4,
      step_up_proof_expires_at=$5, step_up_trust_generation=$6 WHERE id=$1`,
    [attempt.id, ...Object.values(stepUp(linkRow))],
  )
const memberKey = (f: IdentityFixture) => apiKey(f.db, f.member, f.team)

// ---------------------------------------------------------------------------------------
// Identity links
// ---------------------------------------------------------------------------------------

const linkFk =
  'CONSTRAINT sso_identity_links_provider FOREIGN KEY (organization_id, provider_id)\n    REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE'
const linkIdentityRow =
  'NEW.issuer, NEW.subject, NEW.user_id, NEW.created_at)\n     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.provider_id, OLD.issuer, OLD.subject, OLD.user_id, OLD.created_at)'
const linkRetained =
  'IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)\n       AND EXISTS (SELECT FROM auth."user" WHERE id = OLD.user_id) THEN'

const linkProtections: Record<string, IdentityProtection> = {
  'identity link IDs are unique': {
    objects: ['sso_identity_links_pkey', 'sso_identity_links_id_not_null'],
    check: async (f) => {
      await insertRefused(
        f.db,
        links,
        { ...linkValues(f, f.admin), id: f.memberLink.id },
        duplicate('sso_identity_links_pkey'),
      )
    },
    mutants: [dropConstraint(links, 'sso_identity_links_pkey')],
  },
  'a link belongs to a provider of its own team and goes with it': {
    objects: ['sso_identity_links_provider'],
    check: async (f) => {
      // The other team's provider, named under this team with its own issuer: only the key refuses.
      await insertRefused(
        f.db,
        links,
        { ...linkValues(f, f.admin, f.otherProvider), organization_id: f.team },
        foreignKey('sso_identity_links_provider'),
      )
      await insertRefused(
        f.db,
        links,
        { ...linkValues(f, f.admin), provider_id: randomUUID() },
        foreignKey('sso_identity_links_provider'),
      )
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, links, { organization_id: f.team })).toBe(0)
    },
    mutants: [
      dropConstraint(links, 'sso_identity_links_provider'),
      edit(
        "the team's deletion is refused",
        linkFk,
        linkFk.replace('ON DELETE CASCADE', 'ON DELETE NO ACTION'),
      ),
    ],
  },
  'a link belongs to an existing account and goes with it': {
    objects: ['sso_identity_links_user_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        links,
        linkValues(f, randomUUID()),
        foreignKey('sso_identity_links_user_id_fkey'),
      )
      await accepted(f.db, 'DELETE FROM auth."user" WHERE id=$1', [f.member])
      expect(await count(f.db, links, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(links, 'sso_identity_links_user_id_fkey')],
  },
  'subjects are 1 to 1024 bytes': {
    objects: ['sso_identity_links_subject'],
    check: async (f) => {
      for (const subject of ['s', 'a'.repeat(1024), 'é'.repeat(512)])
        await triedInsert(f.db, links, { ...linkValues(f, f.admin), subject })
      for (const subject of ['', 'a'.repeat(1025), 'é'.repeat(513)])
        await insertRefused(
          f.db,
          links,
          { ...linkValues(f, f.admin), subject },
          violation('sso_identity_links_subject'),
        )
    },
    mutants: [
      dropConstraint(links, 'sso_identity_links_subject'),
      edit(
        'subjects may be empty',
        'octet_length(subject) BETWEEN 1 AND 1024',
        'octet_length(subject) BETWEEN 0 AND 1024',
      ),
      edit(
        'subjects are counted in characters',
        'octet_length(subject) BETWEEN 1 AND 1024',
        'char_length(subject) BETWEEN 1 AND 1024',
      ),
    ],
  },
  'link generations are positive': {
    objects: ['sso_identity_links_generation'],
    check: async (f) => {
      await triedInsert(f.db, links, { ...linkValues(f, f.admin), generation: 2 })
      for (const generation of [0, -1])
        await insertRefused(
          f.db,
          links,
          { ...linkValues(f, f.admin), generation },
          violation('sso_identity_links_generation'),
        )
    },
    mutants: [dropConstraint(links, 'sso_identity_links_generation')],
  },
  'a link keeps a normalized proven mailbox': {
    objects: ['sso_identity_links_proven_email'],
    check: async (f) => {
      for (const proven_email of ['a@b', `${'p'.repeat(307)}@example.test`])
        await triedInsert(f.db, links, { ...linkValues(f, f.admin), proven_email })
      for (const proven_email of [
        'Person@example.test',
        ' person@example.test',
        'person@example.test ',
        'person.example.test',
        '@example.test',
        'a@',
        `${'p'.repeat(308)}@example.test`,
      ])
        await insertRefused(
          f.db,
          links,
          { ...linkValues(f, f.admin), proven_email },
          violation('sso_identity_links_proven_email'),
        )
    },
    mutants: [
      dropConstraint(links, 'sso_identity_links_proven_email'),
      edit(
        'proven mailboxes keep their case',
        'proven_email = lower(btrim(proven_email))',
        'proven_email = btrim(proven_email)',
      ),
      edit('proven mailboxes need no @', "\n    AND strpos(proven_email, '@') > 1", ''),
    ],
  },
  'one live link per provider and subject': {
    objects: ['sso_identity_links_live_identity'],
    check: async (f) => {
      const subject = f.memberLink.subject
      await insertRefused(
        f.db,
        links,
        { ...linkValues(f, f.admin), subject },
        duplicate('sso_identity_links_live_identity'),
      )
      // The same subject at another provider of the team is another identity.
      await triedInsert(f.db, links, { ...linkValues(f, f.admin, await provider(f)), subject })
      // Retiring the link frees its subject for an explicit new link.
      await retire(f, f.memberLink)
      await triedInsert(f.db, links, { ...linkValues(f, f.admin), subject })
    },
    mutants: [
      dropIndex('sso_identity_links_live_identity'),
      edit(
        'retired links keep their subject',
        'ON sso_identity_links (provider_id, subject)\n  WHERE retired_at IS NULL',
        'ON sso_identity_links (provider_id, subject)',
      ),
    ],
  },
  'one live link per person and provider': {
    objects: ['sso_identity_links_live_user'],
    check: async (f) => {
      await insertRefused(
        f.db,
        links,
        linkValues(f, f.member),
        duplicate('sso_identity_links_live_user'),
      )
      await triedInsert(f.db, links, linkValues(f, f.member, await provider(f)))
      await retire(f, f.memberLink)
      await triedInsert(f.db, links, linkValues(f, f.member))
    },
    mutants: [
      dropIndex('sso_identity_links_live_user'),
      edit(
        'retired links still count',
        'ON sso_identity_links (provider_id, user_id)\n  WHERE retired_at IS NULL',
        'ON sso_identity_links (provider_id, user_id)',
      ),
    ],
  },
  'a link is retired, not deleted, while its team and its account exist': {
    objects: ['sso_identity_links_retained', 'sso_identity_links_guard'],
    check: async (f) => {
      const retired = await insert(f.db, links, {
        ...linkValues(f, f.member),
        user_id: f.member,
        subject: `retired-${randomUUID()}`,
        generation: 2,
        retired_at: at(-60),
      })
      for (const row of [f.memberLink, retired])
        await refused(
          f.db,
          'DELETE FROM sso_identity_links WHERE id=$1',
          [row.id],
          violation('sso_identity_links_retained'),
        )
      const admin = await link(f, f.admin)
      expect(await count(f.db, links, { organization_id: f.team })).toBe(3)
      // The account's deletion removes its links; the team's deletion removes the rest.
      await accepted(f.db, 'DELETE FROM auth."user" WHERE id=$1', [f.member])
      expect(await count(f.db, links, { user_id: f.member })).toBe(0)
      expect(await count(f.db, links, { id: admin.id })).toBe(1)
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, links, { organization_id: f.team })).toBe(0)
    },
    mutants: [
      silence('sso_identity_links_retained'),
      edit(
        'retired links may be deleted',
        linkRetained,
        linkRetained.replace('IF EXISTS', 'IF OLD.retired_at IS NULL AND EXISTS'),
      ),
      edit(
        "the account's deletion is refused",
        linkRetained,
        'IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN',
      ),
      dropTrigger(links, 'sso_identity_links_guard'),
    ],
  },
  'new links need an enabled provider': {
    objects: ['sso_identity_links_enabled_provider'],
    check: async (f) => {
      for (const values of [{ enabled: false }, { enabled: false, retired_at: at(-60) }])
        await insertRefused(
          f.db,
          links,
          linkValues(f, f.admin, await provider(f, values)),
          violation('sso_identity_links_enabled_provider'),
        )
      // Disabling a provider later keeps its links, which stay retirable.
      await f.db.query('UPDATE sso_providers SET enabled=false WHERE id=$1', [f.provider.id])
      await triedUpdate(f.db, links, byId(f.memberLink), { retired_at: at(0), generation: 2 })
    },
    mutants: [silence('sso_identity_links_enabled_provider')],
  },
  "a link repeats its provider's issuer": {
    objects: ['sso_identity_links_issuer'],
    check: async (f) => {
      // Issuers compare exactly, as OIDC requires: a trailing slash or another case is
      // another issuer.
      const issuers = [
        f.otherProvider.issuer,
        `${f.provider.issuer}/`,
        (f.provider.issuer as string).toUpperCase(),
      ]
      for (const issuer of issuers)
        await insertRefused(
          f.db,
          links,
          { ...linkValues(f, f.admin), issuer },
          violation('sso_identity_links_issuer'),
        )
    },
    mutants: [
      silence('sso_identity_links_issuer'),
      edit(
        'issuers compare without case',
        'AND issuer <> NEW.issuer) THEN',
        'AND lower(issuer) <> lower(NEW.issuer)) THEN',
      ),
    ],
  },
  'a retired link is permanent': {
    objects: ['sso_identity_links_retired_permanent'],
    check: async (f) => {
      const retired = await retire(f, f.memberLink)
      for (const values of [
        { retired_at: null },
        { proven_email: mailboxOf('later'), email_proven_at: at(0) },
        { generation: (retired.generation as number) + 1 },
      ])
        await updateRefused(
          f.db,
          links,
          byId(retired),
          values,
          violation('sso_identity_links_retired_permanent'),
        )
    },
    mutants: [silence('sso_identity_links_retired_permanent')],
  },
  'link identity is immutable': {
    objects: ['sso_identity_links_identity_immutable'],
    check: async (f) => {
      const second = await provider(f, { issuer: f.provider.issuer })
      for (const values of [
        { subject: `synthetic-subject-${randomUUID()}` },
        { user_id: f.admin },
        { issuer: `${f.provider.issuer}/other` },
        { provider_id: second.id },
        { organization_id: f.otherTeam },
        { created_at: at(-3600) },
        { id: randomUUID() },
      ])
        await updateRefused(
          f.db,
          links,
          byId(f.memberLink),
          values,
          violation('sso_identity_links_identity_immutable'),
        )
    },
    mutants: [
      silence('sso_identity_links_identity_immutable'),
      edits('the subject may change', [
        [
          linkIdentityRow,
          linkIdentityRow.replaceAll(' NEW.subject,', '').replaceAll(' OLD.subject,', ''),
        ],
      ]),
      edits('the person may change', [
        [
          linkIdentityRow,
          linkIdentityRow.replaceAll(' NEW.user_id,', '').replaceAll(' OLD.user_id,', ''),
        ],
      ]),
    ],
  },
  'link generations never decrease': {
    objects: ['sso_identity_links_generation_monotonic'],
    check: async (f) => {
      const row = await insert(f.db, links, { ...linkValues(f, f.admin), generation: 3 })
      await updateRefused(
        f.db,
        links,
        byId(row),
        { generation: 2 },
        violation('sso_identity_links_generation_monotonic'),
      )
      await triedUpdate(f.db, links, byId(row), { generation: 4 })
    },
    mutants: [silence('sso_identity_links_generation_monotonic')],
  },
  'retiring a link takes a new generation': {
    objects: ['sso_identity_links_retirement_generation'],
    check: async (f) => {
      await updateRefused(
        f.db,
        links,
        byId(f.memberLink),
        { retired_at: at(0) },
        violation('sso_identity_links_retirement_generation'),
      )
      await triedUpdate(f.db, links, byId(f.memberLink), { retired_at: at(0), generation: 2 })
    },
    mutants: [silence('sso_identity_links_retirement_generation')],
  },
  'a newly proven link mailbox takes a later proof time': {
    objects: ['sso_identity_links_email_proof'],
    check: async (f) => {
      const where = byId(f.memberLink)
      await updateRefused(
        f.db,
        links,
        where,
        { proven_email: mailboxOf('changed') },
        violation('sso_identity_links_email_proof'),
      )
      await updateRefused(
        f.db,
        links,
        where,
        { email_proven_at: at(-3600) },
        violation('sso_identity_links_email_proof'),
      )
      await triedUpdate(f.db, links, where, {
        proven_email: mailboxOf('changed'),
        email_proven_at: at(0),
      })
      await triedUpdate(f.db, links, where, { email_proven_at: at(0) })
    },
    mutants: [
      silence('sso_identity_links_email_proof'),
      edit(
        'the proof time may move back',
        'IF NEW.email_proven_at < OLD.email_proven_at\n     OR (',
        'IF (',
      ),
      edit(
        'the mailbox may change without a new proof',
        '\n     OR (NEW.proven_email <> OLD.proven_email AND NEW.email_proven_at <= OLD.email_proven_at)',
        '',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------------------
// Pending attempts
// ---------------------------------------------------------------------------------------

const attemptFrozenNew =
  'NEW.session_id, NEW.browser_binding_digest, NEW.operation, NEW.input_digest, NEW.created_at,\n         NEW.expires_at)'
const attemptFrozenOld =
  'OLD.user_id, OLD.session_id, OLD.browser_binding_digest, OLD.operation, OLD.input_digest,\n         OLD.created_at, OLD.expires_at) THEN'
const startsOpenRecorded =
  '\n       OR num_nonnulls(NEW.mailbox_proven_at, NEW.mailbox_proof_expires_at, NEW.step_up_provider_id,\n            NEW.step_up_link_id, NEW.step_up_authenticated_at, NEW.step_up_proof_expires_at,\n            NEW.step_up_trust_generation, NEW.consumed_at) > 0'
const mailboxProofCheck = {
  shape: '(mailbox_proven_at IS NULL) = (mailbox_proof_expires_at IS NULL)\n    AND ',
  required: '      requires_mailbox\n      AND mailbox_proof_expires_at > mailbox_proven_at',
  after: '\n      AND mailbox_proof_expires_at > mailbox_proven_at',
  attempt: '\n      AND mailbox_proof_expires_at <= expires_at',
  window: "\n      AND mailbox_proof_expires_at <= mailbox_proven_at + interval '300 seconds'",
}
const stepUpCheck = {
  shape: 'IN (0, 5)',
  required: '      requires_sso\n      AND step_up_authenticated_at',
  skew: "\n      AND step_up_authenticated_at >= created_at - interval '60 seconds'",
  after: '\n      AND step_up_proof_expires_at > step_up_authenticated_at',
  attempt: '\n      AND step_up_proof_expires_at <= expires_at',
  window:
    "\n      AND step_up_proof_expires_at <= step_up_authenticated_at + interval '300 seconds'",
}

/** A fresh proof that requires a step-up, with the owner's live link at the provider. */
async function stepUpAttempt(f: IdentityFixture, methods = { sso: true }) {
  const ownerLink = await link(f, f.owner)
  const attempt = await insert(f.db, attempts, freshProofValues(f, methods))
  return { ownerLink, attempt }
}
/** A complete attempt row for statements that run with triggers off. */
const rawAttempt = (f: IdentityFixture, values: Row = {}): Row => ({
  ...freshProofValues(f),
  created_at: at(-100),
  expires_at: at(400),
  ...values,
})

const attemptProtections: Record<string, IdentityProtection> = {
  'attempt IDs are unique across teams': {
    objects: ['sso_attempts_pkey', 'sso_attempts_id_not_null'],
    check: async (f) => {
      const id = randomUUID()
      await insert(f.db, attempts, { ...freshProofValues(f), id })
      await insertRefused(
        f.db,
        attempts,
        { ...otherTeamFreshProof(f), id },
        duplicate('sso_attempts_pkey'),
      )
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_pkey')],
  },
  'attempts are sign-ins, tests, links or fresh proofs': {
    objects: ['sso_attempts_kind'],
    check: async (f) => {
      for (const values of [
        signInValues(f),
        testValues(f),
        linkAttemptValues(f),
        freshProofValues(f),
      ])
        await triedInsert(f.db, attempts, values)
      for (const kind of ['admission', 'Test', 'step_up'])
        await insertRefused(
          f.db,
          attempts,
          { ...testValues(f), kind },
          violation('sso_attempts_kind'),
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_kind'),
      edit(
        'admission attempts accepted',
        "kind IN ('sign_in', 'test', 'link', 'fresh_proof')",
        "kind IN ('sign_in', 'test', 'link', 'fresh_proof', 'admission')",
      ),
    ],
  },
  'a fresh proof belongs to an existing organization and goes with it': {
    objects: ['sso_attempts_organization_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        attempts,
        { ...freshProofValues(f), organization_id: randomUUID() },
        foreignKey('sso_attempts_organization_id_fkey'),
      )
      await insert(f.db, attempts, freshProofValues(f))
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, attempts, { organization_id: f.team })).toBe(0)
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_organization_id_fkey')],
  },
  'an attempt is bound to a provider of its own team': {
    objects: ['sso_attempts_provider'],
    check: async (f) => {
      await insertRefused(
        f.db,
        attempts,
        { ...signInValues(f, f.otherProvider), organization_id: f.team },
        foreignKey('sso_attempts_provider'),
      )
      await insertRefused(
        f.db,
        attempts,
        { ...testValues(f), provider_id: randomUUID() },
        foreignKey('sso_attempts_provider'),
      )
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_provider')],
  },
  "an attempt's session exists, and its deletion ends the attempt": {
    objects: ['sso_attempts_session_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        attempts,
        { ...testValues(f), session_id: randomUUID() },
        foreignKey('sso_attempts_session_id_fkey'),
      )
      const attempt = await insert(f.db, attempts, linkAttemptValues(f))
      await accepted(f.db, 'DELETE FROM auth.session WHERE id=$1', [f.sessions[f.member]])
      expect(await count(f.db, attempts, byId(attempt))).toBe(0)
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_session_id_fkey')],
  },
  "a step-up comes through the attempt's own person's link in its team": {
    objects: ['sso_attempts_step_up_link'],
    check: async (f) => {
      const { attempt } = await stepUpAttempt(f)
      const adminLink = await link(f, f.admin)
      for (const values of [
        stepUp(adminLink),
        { ...stepUp(adminLink), step_up_link_id: randomUUID() },
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          values,
          foreignKey('sso_attempts_step_up_link'),
        )
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_step_up_link')],
  },
  'an attempt has the provider, person and session its kind needs': {
    objects: ['sso_attempts_kind_shape'],
    check: async (f) => {
      for (const values of [
        // A sign-in starts before any session.
        { ...signInValues(f), user_id: f.owner, session_id: f.sessions[f.owner] },
        // A fresh proof names no provider.
        { ...freshProofValues(f), provider_id: f.provider.id, provider_revision: 1 },
        { ...signInValues(f), provider_revision: null },
        { ...freshProofValues(f), user_id: null },
        { ...testValues(f), session_id: null },
      ])
        await insertRefused(f.db, attempts, values, violation('sso_attempts_kind_shape'))
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_kind_shape'),
      edit(
        'a fresh proof may name a provider',
        "(provider_id IS NULL) = (kind = 'fresh_proof')\n    AND ",
        '',
      ),
      edit(
        'a provider may have no revision',
        '\n    AND (provider_revision IS NULL) = (provider_id IS NULL)',
        '',
      ),
      edit('a person is optional', "\n    AND (user_id IS NULL) = (kind = 'sign_in')", ''),
      edit('a session is optional', "\n    AND (session_id IS NULL) = (kind = 'sign_in')", ''),
    ],
  },
  'attempt digests are SHA-256 hex': {
    objects: ['sso_attempts_digests'],
    check: async (f) => {
      for (const values of [
        { browser_binding_digest: digest().toUpperCase() },
        { browser_binding_digest: digest().slice(1) },
        { input_digest: `${digest().slice(1)}g` },
        { input_digest: '' },
      ])
        await insertRefused(
          f.db,
          attempts,
          { ...testValues(f), ...values },
          violation('sso_attempts_digests'),
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_digests'),
      edit(
        'browser bindings unchecked',
        "browser_binding_digest ~ '^[0-9a-f]{64}$' AND input_digest",
        'input_digest',
      ),
      edit('input digests unchecked', " AND input_digest ~ '^[0-9a-f]{64}$'", ''),
    ],
  },
  'operations are identifiers': {
    objects: ['sso_attempts_operation'],
    check: async (f) => {
      for (const operation of ['createSsoProvider', 'sign_in', `a${'b'.repeat(63)}`])
        await triedInsert(f.db, attempts, { ...freshProofValues(f), operation })
      for (const operation of [
        '',
        'CreateSsoProvider',
        'create-sso-provider',
        'create sso',
        `a${'b'.repeat(64)}`,
      ])
        await insertRefused(
          f.db,
          attempts,
          { ...freshProofValues(f), operation },
          violation('sso_attempts_operation'),
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_operation'),
      edit('operations may contain hyphens', '[a-z][A-Za-z0-9_]{0,63}', '[a-z][A-Za-z0-9_-]{0,63}'),
    ],
  },
  'only a fresh proof requires a step-up, and a fresh proof requires a method': {
    objects: ['sso_attempts_methods'],
    check: async (f) => {
      for (const values of [
        { ...signInValues(f), requires_sso: true },
        { ...testValues(f), requires_sso: true },
        freshProofValues(f, {}),
      ])
        await insertRefused(f.db, attempts, values, violation('sso_attempts_methods'))
      await triedInsert(f.db, attempts, freshProofValues(f, { sso: true }))
      await triedInsert(f.db, attempts, freshProofValues(f, { sso: true, mailbox: true }))
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_methods'),
      edit(
        'any attempt may require a step-up',
        "(NOT requires_sso OR kind = 'fresh_proof')\n    AND ",
        '',
      ),
      edit(
        'a fresh proof may require nothing',
        "\n    AND (kind <> 'fresh_proof' OR requires_mailbox OR requires_sso)",
        '',
      ),
    ],
  },
  'attempt mailboxes are normalized addresses': {
    objects: ['sso_attempts_mailbox'],
    check: async (f) => {
      for (const mailbox of ['Owner@example.test', ' owner@example.test', 'owner', '@example.test'])
        await insertRefused(
          f.db,
          attempts,
          { ...freshProofValues(f), mailbox },
          violation('sso_attempts_mailbox'),
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_mailbox'),
      edit(
        'mailboxes keep their case',
        'mailbox = lower(btrim(mailbox))',
        'mailbox = btrim(mailbox)',
      ),
    ],
  },
  'a required mailbox is chosen': {
    objects: ['sso_attempts_mailbox_required'],
    check: async (f) => {
      for (const values of [
        { ...freshProofValues(f), mailbox: null },
        { ...signInValues(f), requires_mailbox: true },
      ])
        await insertRefused(f.db, attempts, values, violation('sso_attempts_mailbox_required'))
    },
    mutants: [dropConstraint(attempts, 'sso_attempts_mailbox_required')],
  },
  'a mailbox proof is whole, for a required mailbox, and within both lifetimes': {
    objects: ['sso_attempts_mailbox_proof'],
    check: async (f) => {
      const start = at(-50)
      const proven = { mailbox_proven_at: start, mailbox_proof_expires_at: at(200) }
      await insertAccepted(f.db, attempts, rawAttempt(f, proven), withoutTriggers)
      for (const values of [
        { mailbox_proven_at: start },
        { mailbox_proof_expires_at: at(200) },
        { ...proven, requires_mailbox: false, mailbox: null, requires_sso: true },
        { mailbox_proven_at: start, mailbox_proof_expires_at: start },
        { ...proven, mailbox_proof_expires_at: at(150), expires_at: at(100) },
        { mailbox_proven_at: start, mailbox_proof_expires_at: at(260) },
      ])
        await insertRefused(
          f.db,
          attempts,
          rawAttempt(f, values),
          violation('sso_attempts_mailbox_proof'),
          withoutTriggers,
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_mailbox_proof'),
      edit('a proof time without an expiry', mailboxProofCheck.shape, ''),
      edit(
        'a proof without a required mailbox',
        mailboxProofCheck.required,
        '      mailbox_proof_expires_at > mailbox_proven_at',
      ),
      edit('a proof may end before it starts', mailboxProofCheck.after, ''),
      edit('a proof may outlive its attempt', mailboxProofCheck.attempt, ''),
      edit('a proof may outlive freshAdministrationProof', mailboxProofCheck.window, ''),
    ],
  },
  'a step-up is whole, for a required step-up, fresh, and within both lifetimes': {
    objects: ['sso_attempts_step_up'],
    check: async (f) => {
      const base = {
        ...freshProofValues(f, { sso: true }),
        created_at: at(-100),
        expires_at: at(400),
      }
      const recorded = stepUp(f.memberLink, at(-90), at(150))
      await insertAccepted(f.db, attempts, { ...base, ...recorded }, withoutTriggers)
      for (const values of [
        { step_up_link_id: f.memberLink.id },
        { ...recorded, requires_sso: false, requires_mailbox: true, mailbox: mailboxOf('owner') },
        { ...recorded, step_up_authenticated_at: at(-170), step_up_proof_expires_at: at(100) },
        { ...recorded, step_up_proof_expires_at: recorded.step_up_authenticated_at },
        { ...recorded, expires_at: at(100) },
        { ...recorded, step_up_proof_expires_at: at(220) },
      ])
        await insertRefused(
          f.db,
          attempts,
          { ...base, ...values },
          violation('sso_attempts_step_up'),
          withoutTriggers,
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_step_up'),
      edit('a partial step-up', stepUpCheck.shape, 'IN (0, 1, 2, 3, 4, 5)'),
      edit(
        'a step-up without a required step-up',
        stepUpCheck.required,
        '      step_up_authenticated_at',
      ),
      edit('an authentication before the attempt', stepUpCheck.skew, ''),
      edit('a step-up may end before it starts', stepUpCheck.after, ''),
      edit('a step-up may outlive its attempt', stepUpCheck.attempt, ''),
      edit('a step-up may outlive freshAdministrationProof', stepUpCheck.window, ''),
    ],
  },
  'attempts last at most authenticationAttemptLifetime': {
    objects: ['sso_attempts_lifetime'],
    check: async (f) => {
      await insertRefused(
        f.db,
        attempts,
        { ...signInValues(f), expires_at: at(700) },
        violation('sso_attempts_lifetime'),
      )
      for (const expires_at of [at(-100), at(501)])
        await insertRefused(
          f.db,
          attempts,
          rawAttempt(f, { expires_at }),
          violation('sso_attempts_lifetime'),
          withoutTriggers,
        )
    },
    mutants: [
      dropConstraint(attempts, 'sso_attempts_lifetime'),
      edit(
        'attempts last an hour',
        "expires_at <= created_at + interval '600 seconds'",
        "expires_at <= created_at + interval '3600 seconds'",
      ),
      edit(
        'attempts may end before they start',
        "expires_at > created_at AND expires_at <= created_at + interval '600 seconds'",
        "expires_at <= created_at + interval '600 seconds'",
      ),
    ],
  },
  'attempts start unexpired, unproven and unconsumed': {
    objects: ['sso_attempts_starts_open', 'sso_attempts_guard'],
    check: async (f) => {
      const { ownerLink } = await stepUpAttempt(f)
      for (const values of [
        { ...signInValues(f), created_at: at(120), expires_at: at(400) },
        { ...signInValues(f), created_at: at(-300), expires_at: at(-10) },
        { ...signInValues(f), consumed_at: at(-1) },
        { ...freshProofValues(f), mailbox_proven_at: at(-1), mailbox_proof_expires_at: at(200) },
        { ...freshProofValues(f, { sso: true }), ...stepUp(ownerLink) },
      ])
        await insertRefused(f.db, attempts, values, violation('sso_attempts_starts_open'))
    },
    mutants: [
      silence('sso_attempts_starts_open'),
      editFunction(
        'guard_sso_attempt',
        'attempts may start in the future',
        'NEW.created_at > clock_timestamp() OR ',
        '',
      ),
      editFunction(
        'guard_sso_attempt',
        'attempts may start expired',
        ' OR NEW.expires_at <= clock_timestamp()',
        '',
      ),
      editFunction(
        'guard_sso_attempt',
        'attempts may start proven or consumed',
        startsOpenRecorded,
        '',
      ),
      dropTrigger(attempts, 'sso_attempts_guard'),
    ],
  },
  'personal organizations have no attempts': {
    objects: ['sso_attempts_guard'],
    check: async (f) => {
      await insertRefused(
        f.db,
        attempts,
        {
          ...freshProofValues(f),
          organization_id: f.personal,
          user_id: f.personalUser,
          session_id: f.sessions[f.personalUser],
        },
        violation('sso_team_organization'),
      )
    },
    mutants: [
      editFunction(
        'guard_sso_attempt',
        'attempts skip the team check',
        'PERFORM public.sso_team_organization(NEW.organization_id);',
        '',
      ),
    ],
  },
  'an attempt needs a live provider, enabled unless it tests a draft': {
    objects: ['sso_attempts_live_provider'],
    check: async (f) => {
      const draft = await provider(f, { enabled: false })
      const retired = await provider(f, { enabled: false, retired_at: at(-60) })
      for (const values of [
        signInValues(f, draft),
        linkAttemptValues(f, draft),
        testValues(f, retired),
        signInValues(f, retired),
      ])
        await insertRefused(f.db, attempts, values, violation('sso_attempts_live_provider'))
      await triedInsert(f.db, attempts, testValues(f, draft))
    },
    mutants: [
      silence('sso_attempts_live_provider'),
      edit(
        'drafts accept sign-ins and links',
        "retired_at IS NOT NULL OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled)",
        'retired_at IS NOT NULL',
      ),
      edit(
        'retired providers accept tests',
        "retired_at IS NOT NULL OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled)",
        "(NEW.kind IN ('sign_in', 'link') AND NOT enabled)",
      ),
    ],
  },
  "an attempt is bound to its provider's current revision": {
    objects: ['sso_attempts_current_revision'],
    check: async (f) => {
      await f.db.query('UPDATE sso_providers SET revision=2, configuration=$2 WHERE id=$1', [
        f.provider.id,
        sealed(),
      ])
      for (const provider_revision of [1, 3])
        await insertRefused(
          f.db,
          attempts,
          { ...signInValues(f), provider_revision },
          violation('sso_attempts_current_revision'),
        )
      await triedInsert(f.db, attempts, { ...signInValues(f), provider_revision: 2 })
    },
    mutants: [silence('sso_attempts_current_revision')],
  },
  "an attempt's session is its person's current session": {
    objects: ['sso_attempts_session'],
    check: async (f) => {
      const expired = await session(f.db, f.owner, at(-60))
      for (const session_id of [f.sessions[f.admin], expired])
        await insertRefused(
          f.db,
          attempts,
          { ...testValues(f), session_id },
          violation('sso_attempts_session'),
        )
    },
    mutants: [
      silence('sso_attempts_session'),
      edit(
        'expired sessions accepted',
        '("userId" <> NEW.user_id OR "expiresAt" <= clock_timestamp())',
        '("userId" <> NEW.user_id)',
      ),
    ],
  },
  'a consumed attempt is final': {
    objects: ['sso_attempts_consumed_final'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, { ...signInValues(f) })
      await f.db.query('UPDATE sso_attempts SET consumed_at=now() WHERE id=$1', [attempt.id])
      for (const values of [
        { consumed_at: at(1) },
        { requires_mailbox: true, mailbox: mailboxOf('later') },
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          values,
          violation('sso_attempts_consumed_final'),
        )
    },
    mutants: [silence('sso_attempts_consumed_final')],
  },
  'an expired attempt cannot change': {
    objects: ['sso_attempts_unexpired'],
    check: async (f) => {
      const attempt = await seeded(f.db, attempts, {
        ...signInValues(f),
        created_at: at(-650),
        expires_at: at(-100),
      })
      for (const values of [
        { consumed_at: at(0) },
        { requires_mailbox: true, mailbox: mailboxOf('late') },
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          values,
          violation('sso_attempts_unexpired'),
        )
    },
    mutants: [silence('sso_attempts_unexpired')],
  },
  'what an attempt was created for is frozen': {
    objects: ['sso_attempts_frozen'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, testValues(f))
      const second = await provider(f)
      for (const values of [
        { kind: 'link' },
        { operation: 'linkSsoAccount' },
        { input_digest: digest() },
        { browser_binding_digest: digest() },
        { expires_at: at(500) },
        { created_at: at(-10) },
        { session_id: await session(f.db, f.owner) },
        { user_id: f.coOwner, session_id: f.sessions[f.coOwner] },
        { provider_id: second.id },
        { provider_revision: 2 },
        { organization_id: f.otherTeam },
        { id: randomUUID() },
      ])
        await updateRefused(f.db, attempts, byId(attempt), values, violation('sso_attempts_frozen'))
    },
    mutants: [
      silence('sso_attempts_frozen'),
      edits('the input digest may change', [
        [attemptFrozenNew, attemptFrozenNew.replace(' NEW.input_digest,', '')],
        [attemptFrozenOld, attemptFrozenOld.replace(' OLD.input_digest,', '')],
      ]),
      edits('the operation may change', [
        [attemptFrozenNew, attemptFrozenNew.replace(' NEW.operation,', '')],
        [attemptFrozenOld, attemptFrozenOld.replace(' OLD.operation,', '')],
      ]),
      edits('the expiry may move', [
        [attemptFrozenNew, attemptFrozenNew.replace(',\n         NEW.expires_at)', ')')],
        [attemptFrozenOld, attemptFrozenOld.replace(', OLD.expires_at)', ')')],
      ]),
      edits('the provider revision may change', [
        ['NEW.provider_id, NEW.provider_revision, NEW.user_id,', 'NEW.provider_id, NEW.user_id,'],
        ['OLD.provider_id, OLD.provider_revision,', 'OLD.provider_id,'],
      ]),
    ],
  },
  'an attempt only adds the mailbox to its required proofs': {
    objects: ['sso_attempts_methods_added'],
    check: async (f) => {
      const signIn = await insert(f.db, attempts, signInValues(f))
      const ssoOnly = await insert(f.db, attempts, freshProofValues(f, { sso: true }))
      const mailboxOnly = await insert(f.db, attempts, freshProofValues(f))
      const both = await insert(f.db, attempts, freshProofValues(f, { sso: true, mailbox: true }))
      // A sign-in that must prove a mailbox, and a step-up that cannot prove freshness.
      for (const row of [signIn, ssoOnly])
        await triedUpdate(f.db, attempts, byId(row), {
          requires_mailbox: true,
          mailbox: mailboxOf('added'),
        })
      for (const [row, values] of [
        [mailboxOnly, { requires_sso: true }],
        [both, { requires_sso: false }],
        [both, { requires_mailbox: false }],
      ] as const)
        await updateRefused(
          f.db,
          attempts,
          byId(row),
          values,
          violation('sso_attempts_methods_added'),
        )
    },
    mutants: [
      silence('sso_attempts_methods_added'),
      edit(
        'the mailbox requirement may be dropped',
        ' OR (OLD.requires_mailbox AND NOT NEW.requires_mailbox)',
        '',
      ),
      edit(
        'the step-up requirement may change',
        'NEW.requires_sso IS DISTINCT FROM OLD.requires_sso OR ',
        '',
      ),
    ],
  },
  "an attempt's mailbox is fixed once chosen": {
    objects: ['sso_attempts_mailbox_fixed'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, linkAttemptValues(f))
      await triedUpdate(f.db, attempts, byId(attempt), { mailbox: mailboxOf('asserted') })
      await f.db.query('UPDATE sso_attempts SET mailbox=$2 WHERE id=$1', [
        attempt.id,
        mailboxOf('asserted'),
      ])
      for (const mailbox of [mailboxOf('other'), null])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          { mailbox },
          violation('sso_attempts_mailbox_fixed'),
        )
    },
    mutants: [silence('sso_attempts_mailbox_fixed')],
  },
  'each proof is recorded once': {
    objects: ['sso_attempts_proof_once'],
    check: async (f) => {
      const mailbox = await insert(f.db, attempts, freshProofValues(f))
      await proveMailbox(f.db, mailbox)
      for (const values of [
        { mailbox_proven_at: at(1) },
        { mailbox_proven_at: null, mailbox_proof_expires_at: null },
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(mailbox),
          values,
          violation('sso_attempts_proof_once'),
        )
      const { ownerLink, attempt } = await stepUpAttempt(f)
      await recordStepUp(f, attempt, ownerLink)
      for (const values of [
        { step_up_authenticated_at: at(-30) },
        { step_up_proof_expires_at: at(200) },
        { step_up_trust_generation: 2 },
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          values,
          violation('sso_attempts_proof_once'),
        )
    },
    mutants: [
      silence('sso_attempts_proof_once'),
      edit(
        'the mailbox proof may be rewritten',
        'IF (OLD.mailbox_proven_at IS NOT NULL\n      AND',
        'IF (false\n      AND',
      ),
      edit(
        'the step-up may be rewritten',
        'OR (OLD.step_up_link_id IS NOT NULL\n      AND',
        'OR (false\n      AND',
      ),
    ],
  },
  "a mailbox proof consumes the attempt's token and ends with it": {
    objects: ['sso_attempts_mailbox_token'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      const prove = (expires: unknown) => ({
        mailbox_proven_at: at(0),
        mailbox_proof_expires_at: expires,
      })
      await updateRefused(
        f.db,
        attempts,
        byId(attempt),
        prove(at(200)),
        violation('sso_attempts_mailbox_token'),
      )
      const token = await insert(f.db, tokens, tokenValues(attempt))
      await updateRefused(
        f.db,
        attempts,
        byId(attempt),
        prove(token.expires_at),
        violation('sso_attempts_mailbox_token'),
      )
      await f.db.query('UPDATE sso_mailbox_tokens SET consumed_at=now() WHERE token_digest=$1', [
        token.token_digest,
      ])
      const earlier = new Date((token.expires_at as Date).getTime() - 10_000)
      await updateRefused(
        f.db,
        attempts,
        byId(attempt),
        prove(earlier),
        violation('sso_attempts_mailbox_token'),
      )
      await triedUpdate(f.db, attempts, byId(attempt), prove(token.expires_at))
    },
    mutants: [
      silence('sso_attempts_mailbox_token'),
      edit(
        'an unconsumed token suffices',
        'WHERE attempt_id = NEW.id AND consumed_at IS NOT NULL AND expires_at',
        'WHERE attempt_id = NEW.id AND expires_at',
      ),
      edit(
        'the proof may outlive the token',
        ' AND expires_at = NEW.mailbox_proof_expires_at\n  ) THEN',
        '\n  ) THEN',
      ),
    ],
  },
  'a step-up comes from a live link at an enabled provider under the current trust generation': {
    objects: ['sso_attempts_step_up_proof'],
    check: async (f) => {
      const { ownerLink, attempt } = await stepUpAttempt(f)
      const retiredLink = await insert(f.db, links, {
        ...linkValues(f, f.owner),
        generation: 2,
        retired_at: at(-60),
      })
      const draft = await provider(f)
      const draftLink = await link(f, f.owner, draft)
      await f.db.query('UPDATE sso_providers SET enabled=false WHERE id=$1', [draft.id])
      for (const values of [
        stepUp(ownerLink, at(120), at(300)),
        stepUp(retiredLink),
        stepUp(draftLink),
        stepUp(ownerLink, at(-5), at(240), 2),
      ])
        await updateRefused(
          f.db,
          attempts,
          byId(attempt),
          values,
          violation('sso_attempts_step_up_proof'),
        )
      await triedUpdate(f.db, attempts, byId(attempt), stepUp(ownerLink))
      // After a trust change only the new generation counts.
      await insert(f.db, 'sso_policies', { organization_id: f.team, trust_generation: 2 })
      await updateRefused(
        f.db,
        attempts,
        byId(attempt),
        stepUp(ownerLink),
        violation('sso_attempts_step_up_proof'),
      )
      await triedUpdate(f.db, attempts, byId(attempt), stepUp(ownerLink, at(-5), at(240), 2))
    },
    mutants: [
      silence('sso_attempts_step_up_proof'),
      edit(
        'authentication from the future',
        "    NEW.step_up_authenticated_at > clock_timestamp() + interval '60 seconds'\n    OR NEW.step_up_trust_generation",
        '    NEW.step_up_trust_generation',
      ),
      edit(
        'any trust generation steps up',
        '    OR NEW.step_up_trust_generation <> coalesce(\n      (SELECT trust_generation FROM public.sso_policies WHERE organization_id = NEW.organization_id), 1)\n    OR EXISTS (',
        '    OR EXISTS (',
      ),
      edit(
        'retired links step up',
        '\n        AND (l.retired_at IS NOT NULL OR NOT p.enabled)',
        '\n        AND (NOT p.enabled)',
      ),
      edit(
        'disabled providers step up',
        '\n        AND (l.retired_at IS NOT NULL OR NOT p.enabled)',
        '\n        AND (l.retired_at IS NOT NULL)',
      ),
    ],
  },
  'an attempt is consumed only with every required proof live': {
    objects: ['sso_attempts_proven'],
    check: async (f) => {
      const ownerLink = await link(f, f.owner)
      const unproven = [
        await insert(f.db, attempts, freshProofValues(f)),
        await insert(f.db, attempts, freshProofValues(f, { sso: true })),
        await seeded(f.db, attempts, {
          ...freshProofValues(f),
          created_at: at(-400),
          expires_at: at(100),
          mailbox_proven_at: at(-350),
          mailbox_proof_expires_at: at(-60),
        }),
        await seeded(f.db, attempts, {
          ...freshProofValues(f, { sso: true }),
          created_at: at(-400),
          expires_at: at(100),
          ...stepUp(ownerLink, at(-390), at(-100)),
        }),
      ]
      const both = await insert(f.db, attempts, freshProofValues(f, { sso: true, mailbox: true }))
      await proveMailbox(f.db, both)
      for (const row of [...unproven, both])
        await updateRefused(
          f.db,
          attempts,
          byId(row),
          { consumed_at: at(0) },
          violation('sso_attempts_proven'),
        )
      const proven = await insert(f.db, attempts, freshProofValues(f))
      await proveMailbox(f.db, proven)
      await triedUpdate(f.db, attempts, byId(proven), { consumed_at: at(0) })
      // A sign-in that needs no proof is consumed as soon as its callback completes.
      await triedUpdate(f.db, attempts, byId(await insert(f.db, attempts, signInValues(f))), {
        consumed_at: at(0),
      })
    },
    mutants: [
      silence('sso_attempts_proven'),
      edit('the mailbox requirement is ignored', '(NEW.requires_mailbox AND (', '(false AND ('),
      edit('the step-up requirement is ignored', 'OR (NEW.requires_sso AND (', 'OR (false AND ('),
      edit(
        'expired mailbox proofs count',
        'NEW.mailbox_proof_expires_at IS NULL OR NEW.mailbox_proof_expires_at <= clock_timestamp()',
        'NEW.mailbox_proof_expires_at IS NULL',
      ),
      edit(
        'expired step-ups count',
        'NEW.step_up_proof_expires_at IS NULL OR NEW.step_up_proof_expires_at <= clock_timestamp()',
        'NEW.step_up_proof_expires_at IS NULL',
      ),
    ],
  },
  'an attempt is consumed only while what it relied on is unchanged': {
    objects: ['sso_attempts_still_current'],
    check: async (f) => {
      const consume = { consumed_at: at(0) }
      const stale = violation('sso_attempts_still_current')
      // A new provider revision ends the attempts frozen to the old one.
      const revised = await insert(f.db, attempts, testValues(f))
      await f.db.query('UPDATE sso_providers SET revision=2, configuration=$2 WHERE id=$1', [
        f.provider.id,
        sealed(),
      ])
      await updateRefused(f.db, attempts, byId(revised), consume, stale)
      // A disabled provider ends sign-ins and links; a retired one ends tests too.
      const disabled = await provider(f)
      const signIn = await insert(f.db, attempts, signInValues(f, disabled))
      const linking = await insert(f.db, attempts, linkAttemptValues(f, disabled))
      const drafting = await insert(f.db, attempts, testValues(f, disabled))
      await f.db.query('UPDATE sso_providers SET enabled=false WHERE id=$1', [disabled.id])
      for (const row of [signIn, linking])
        await updateRefused(f.db, attempts, byId(row), consume, stale)
      await triedUpdate(f.db, attempts, byId(drafting), consume)
      await f.db.query('UPDATE sso_providers SET retired_at=now() WHERE id=$1', [disabled.id])
      await updateRefused(f.db, attempts, byId(drafting), consume, stale)
      // A step-up ends with its link, its provider's activation and the trust generation.
      const stepped = async (providerRow: Row) => {
        const linkRow = await link(f, f.owner, providerRow)
        const attempt = await insert(f.db, attempts, freshProofValues(f, { sso: true }))
        await recordStepUp(f, attempt, linkRow)
        return { linkRow, attempt }
      }
      const unlinked = await stepped(await provider(f))
      await retire(f, unlinked.linkRow)
      const deactivated = await stepped(await provider(f))
      await f.db.query('UPDATE sso_providers SET enabled=false WHERE id=$1', [
        deactivated.linkRow.provider_id,
      ])
      for (const { attempt } of [unlinked, deactivated])
        await updateRefused(f.db, attempts, byId(attempt), consume, stale)
      const distrusted = await stepped(await provider(f))
      await triedUpdate(f.db, attempts, byId(distrusted.attempt), consume)
      await insert(f.db, 'sso_policies', { organization_id: f.team, trust_generation: 2 })
      await updateRefused(f.db, attempts, byId(distrusted.attempt), consume, stale)
    },
    mutants: [
      silence('sso_attempts_still_current'),
      edit(
        'a new provider revision keeps the attempt',
        '(revision <> NEW.provider_revision OR retired_at IS NOT NULL',
        '(retired_at IS NOT NULL',
      ),
      edit(
        'a retired provider keeps the attempt',
        "(revision <> NEW.provider_revision OR retired_at IS NOT NULL\n             OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled))",
        "(revision <> NEW.provider_revision\n             OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled))",
      ),
      edit(
        'a disabled provider keeps sign-ins and links',
        "\n             OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled))",
        ')',
      ),
      edit(
        'a retired step-up link keeps the attempt',
        'WHERE l.id = NEW.step_up_link_id AND (l.retired_at IS NOT NULL OR NOT p.enabled)',
        'WHERE l.id = NEW.step_up_link_id AND (NOT p.enabled)',
      ),
      edit(
        'a disabled step-up provider keeps the attempt',
        'WHERE l.id = NEW.step_up_link_id AND (l.retired_at IS NOT NULL OR NOT p.enabled)',
        'WHERE l.id = NEW.step_up_link_id AND (l.retired_at IS NOT NULL)',
      ),
      edit(
        'a new trust generation keeps the attempt',
        '\n    OR NEW.step_up_trust_generation <> coalesce(\n      (SELECT trust_generation FROM public.sso_policies WHERE organization_id = NEW.organization_id), 1)\n  ) THEN',
        '\n  ) THEN',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------------------
// Mailbox tokens
// ---------------------------------------------------------------------------------------

const tokenRowNew =
  'ROW(NEW.token_digest, NEW.organization_id, NEW.attempt_id, NEW.issued_at, NEW.expires_at)'
const tokenRowOld =
  'ROW(OLD.token_digest, OLD.organization_id, OLD.attempt_id, OLD.issued_at, OLD.expires_at)'
const awaitingProof =
  'AND (NOT requires_mailbox OR mailbox_proven_at IS NOT NULL OR consumed_at IS NOT NULL\n             OR expires_at <= clock_timestamp())'

const tokenProtections: Record<string, IdentityProtection> = {
  'token digests are unique': {
    objects: ['sso_mailbox_tokens_pkey', 'sso_mailbox_tokens_token_digest_not_null'],
    check: async (f) => {
      const first = await insert(
        f.db,
        tokens,
        tokenValues(await insert(f.db, attempts, freshProofValues(f))),
      )
      const second = await insert(f.db, attempts, freshProofValues(f))
      await insertRefused(
        f.db,
        tokens,
        { ...tokenValues(second), token_digest: first.token_digest },
        duplicate('sso_mailbox_tokens_pkey'),
      )
    },
    mutants: [dropConstraint(tokens, 'sso_mailbox_tokens_pkey')],
  },
  'token digests are SHA-256 hex': {
    objects: ['sso_mailbox_tokens_digest'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      for (const token_digest of [digest().toUpperCase(), digest().slice(2), 'token'])
        await insertRefused(
          f.db,
          tokens,
          { ...tokenValues(attempt), token_digest },
          violation('sso_mailbox_tokens_digest'),
        )
    },
    mutants: [dropConstraint(tokens, 'sso_mailbox_tokens_digest')],
  },
  'an attempt has one token; resending replaces it': {
    objects: ['sso_mailbox_tokens_one_per_attempt'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      const first = await insert(f.db, tokens, tokenValues(attempt))
      await insertRefused(
        f.db,
        tokens,
        tokenValues(attempt),
        duplicate('sso_mailbox_tokens_one_per_attempt'),
      )
      await accepted(f.db, 'DELETE FROM sso_mailbox_tokens WHERE token_digest=$1', [
        first.token_digest,
      ])
      await triedInsert(f.db, tokens, tokenValues(attempt))
    },
    mutants: [dropConstraint(tokens, 'sso_mailbox_tokens_one_per_attempt')],
  },
  'a token belongs to an attempt of its team and goes with it': {
    objects: ['sso_mailbox_tokens_attempt'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      for (const values of [
        { ...tokenValues(attempt), organization_id: f.otherTeam },
        { ...tokenValues(attempt), attempt_id: randomUUID() },
      ])
        await insertRefused(f.db, tokens, values, foreignKey('sso_mailbox_tokens_attempt'))
      await insert(f.db, tokens, tokenValues(attempt))
      await accepted(f.db, 'DELETE FROM sso_attempts WHERE id=$1', [attempt.id])
      expect(await count(f.db, tokens, { attempt_id: attempt.id })).toBe(0)
    },
    mutants: [dropConstraint(tokens, 'sso_mailbox_tokens_attempt')],
  },
  'tokens last at most freshAdministrationProof': {
    objects: ['sso_mailbox_tokens_lifetime'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      await insertRefused(
        f.db,
        tokens,
        tokenValues(attempt, 400),
        violation('sso_mailbox_tokens_lifetime'),
      )
      await insertRefused(
        f.db,
        tokens,
        { ...tokenValues(attempt), issued_at: at(0), expires_at: at(-1) },
        violation('sso_mailbox_tokens_lifetime'),
        withoutTriggers,
      )
    },
    mutants: [
      dropConstraint(tokens, 'sso_mailbox_tokens_lifetime'),
      edit(
        'tokens last ten minutes',
        "expires_at <= issued_at + interval '300 seconds'",
        "expires_at <= issued_at + interval '600 seconds'",
      ),
      edit('tokens may end as they are issued', 'expires_at > issued_at AND ', ''),
    ],
  },
  'tokens start unexpired and unconsumed': {
    objects: ['sso_mailbox_tokens_starts_live', 'sso_mailbox_tokens_guard'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      for (const values of [
        { issued_at: at(120), expires_at: at(200) },
        { issued_at: at(-280), expires_at: at(-10) },
        { consumed_at: at(-1) },
      ])
        await insertRefused(
          f.db,
          tokens,
          { ...tokenValues(attempt), ...values },
          violation('sso_mailbox_tokens_starts_live'),
        )
    },
    mutants: [
      silence('sso_mailbox_tokens_starts_live'),
      edit('tokens may be issued in the future', 'IF NEW.issued_at > clock_timestamp() OR ', 'IF '),
      edit(
        'tokens may start expired',
        ' OR NEW.expires_at <= clock_timestamp() OR NEW.consumed_at',
        ' OR NEW.consumed_at',
      ),
      edit('tokens may start consumed', ' OR NEW.consumed_at IS NOT NULL THEN', ' THEN'),
      dropTrigger(tokens, 'sso_mailbox_tokens_guard'),
    ],
  },
  'a token is issued only for an open attempt awaiting its mailbox proof': {
    objects: ['sso_mailbox_tokens_awaiting_proof'],
    check: async (f) => {
      const signIn = await insert(f.db, attempts, signInValues(f))
      const proven = await insert(f.db, attempts, freshProofValues(f))
      const used = await proveMailbox(f.db, proven)
      await f.db.query('DELETE FROM sso_mailbox_tokens WHERE token_digest=$1', [used.token_digest])
      const consumed = await seeded(f.db, attempts, {
        ...freshProofValues(f),
        created_at: at(-60),
        expires_at: at(400),
        consumed_at: at(-1),
      })
      const expired = await seeded(f.db, attempts, {
        ...freshProofValues(f),
        created_at: at(-650),
        expires_at: at(-100),
      })
      for (const attempt of [signIn, proven, consumed, expired])
        await insertRefused(
          f.db,
          tokens,
          tokenValues(attempt),
          violation('sso_mailbox_tokens_awaiting_proof'),
        )
    },
    mutants: [
      silence('sso_mailbox_tokens_awaiting_proof'),
      edit(
        'attempts without a mailbox get tokens',
        awaitingProof,
        awaitingProof.replace('NOT requires_mailbox OR ', ''),
      ),
      edit(
        'proven attempts get tokens',
        awaitingProof,
        awaitingProof.replace('mailbox_proven_at IS NOT NULL OR ', ''),
      ),
      edit(
        'consumed attempts get tokens',
        awaitingProof,
        awaitingProof.replace(' OR consumed_at IS NOT NULL', ''),
      ),
      edit(
        'expired attempts get tokens',
        awaitingProof,
        awaitingProof.replace('\n             OR expires_at <= clock_timestamp()', ''),
      ),
    ],
  },
  'a token ends no later than its attempt': {
    objects: ['sso_mailbox_tokens_within_attempt'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, { ...freshProofValues(f), expires_at: at(100) })
      await insertRefused(
        f.db,
        tokens,
        tokenValues(attempt, 200),
        violation('sso_mailbox_tokens_within_attempt'),
      )
      await triedInsert(f.db, tokens, tokenValues(attempt, 90))
    },
    mutants: [silence('sso_mailbox_tokens_within_attempt')],
  },
  'a token is immutable and consumed once': {
    objects: ['sso_mailbox_tokens_immutable'],
    check: async (f) => {
      const token = await insert(
        f.db,
        tokens,
        tokenValues(await insert(f.db, attempts, freshProofValues(f))),
      )
      // Another attempt awaiting its proof, which a consumed token must not move to.
      const other = await insert(f.db, attempts, freshProofValues(f))
      for (const values of [
        { expires_at: at(100) },
        { token_digest: digest() },
        { issued_at: at(-10) },
        { attempt_id: other.id },
        { organization_id: f.otherTeam },
      ])
        await updateRefused(
          f.db,
          tokens,
          byDigest(token),
          values,
          violation('sso_mailbox_tokens_immutable'),
        )
      await f.db.query('UPDATE sso_mailbox_tokens SET consumed_at=now() WHERE token_digest=$1', [
        token.token_digest,
      ])
      for (const consumed_at of [at(1), null])
        await updateRefused(
          f.db,
          tokens,
          byDigest(token),
          { consumed_at },
          violation('sso_mailbox_tokens_immutable'),
        )
    },
    mutants: [
      silence('sso_mailbox_tokens_immutable'),
      edit(
        'a token may be consumed again',
        '\n     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)',
        '',
      ),
      edits('a token may move to another attempt', [
        [tokenRowNew, tokenRowNew.replace(' NEW.attempt_id,', '')],
        [tokenRowOld, tokenRowOld.replace(' OLD.attempt_id,', '')],
      ]),
      edits('a token may move to another team', [
        [tokenRowNew, tokenRowNew.replace(' NEW.organization_id,', '')],
        [tokenRowOld, tokenRowOld.replace(' OLD.organization_id,', '')],
      ]),
    ],
  },
  'an expired token cannot be consumed': {
    objects: ['sso_mailbox_tokens_unexpired'],
    check: async (f) => {
      const attempt = await insert(f.db, attempts, freshProofValues(f))
      const token = await seeded(f.db, tokens, {
        ...tokenValues(attempt),
        issued_at: at(-280),
        expires_at: at(-10),
      })
      await updateRefused(
        f.db,
        tokens,
        byDigest(token),
        { consumed_at: at(0) },
        violation('sso_mailbox_tokens_unexpired'),
      )
    },
    mutants: [silence('sso_mailbox_tokens_unexpired')],
  },
}

// ---------------------------------------------------------------------------------------
// Replay cache
// ---------------------------------------------------------------------------------------

const replayProtections: Record<string, IdentityProtection> = {
  'a protocol ID is consumed once per provider and kind': {
    objects: [
      'sso_replay_cache_pkey',
      'sso_replay_cache_provider_id_not_null',
      'sso_replay_cache_kind_not_null',
      'sso_replay_cache_key_digest_not_null',
    ],
    check: async (f) => {
      const entry = await insert(f.db, replay, replayValues(f))
      await insertRefused(
        f.db,
        replay,
        { ...replayValues(f), key_digest: entry.key_digest },
        duplicate('sso_replay_cache_pkey'),
      )
      await triedInsert(f.db, replay, {
        ...replayValues(f),
        key_digest: entry.key_digest,
        kind: 'saml_response',
      })
      await triedInsert(f.db, replay, {
        ...replayValues(f, await provider(f)),
        key_digest: entry.key_digest,
      })
    },
    mutants: [
      dropConstraint(replay, 'sso_replay_cache_pkey'),
      edit(
        'kinds share their keys',
        'PRIMARY KEY (provider_id, kind, key_digest)',
        'PRIMARY KEY (provider_id, key_digest)',
      ),
    ],
  },
  'replay kinds are SAML request, response and assertion IDs': {
    objects: ['sso_replay_cache_kind'],
    check: async (f) => {
      for (const kind of ['saml_request', 'saml_response', 'saml_assertion'])
        await triedInsert(f.db, replay, { ...replayValues(f), kind })
      for (const kind of ['oidc_state', 'SAML_ASSERTION', ''])
        await insertRefused(
          f.db,
          replay,
          { ...replayValues(f), kind },
          violation('sso_replay_cache_kind'),
        )
    },
    mutants: [
      dropConstraint(replay, 'sso_replay_cache_kind'),
      edit(
        'OIDC states accepted',
        "kind IN ('saml_request', 'saml_response', 'saml_assertion')",
        "kind IN ('saml_request', 'saml_response', 'saml_assertion', 'oidc_state')",
      ),
    ],
  },
  'replay keys are SHA-256 hex digests': {
    objects: ['sso_replay_cache_key_digest'],
    check: async (f) => {
      for (const key_digest of ['_a1b2c3', digest().toUpperCase(), `${digest()}0`])
        await insertRefused(
          f.db,
          replay,
          { ...replayValues(f), key_digest },
          violation('sso_replay_cache_key_digest'),
        )
    },
    mutants: [dropConstraint(replay, 'sso_replay_cache_key_digest')],
  },
  'replay entries belong to a provider of their team and go with it': {
    objects: ['sso_replay_cache_provider'],
    check: async (f) => {
      for (const values of [
        { ...replayValues(f, f.otherProvider), organization_id: f.team },
        { ...replayValues(f), provider_id: randomUUID() },
      ])
        await insertRefused(f.db, replay, values, foreignKey('sso_replay_cache_provider'))
      await insert(f.db, replay, replayValues(f))
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, replay, { organization_id: f.team })).toBe(0)
    },
    mutants: [dropConstraint(replay, 'sso_replay_cache_provider')],
  },
  'replay entries are retained past their consumption, for at most 720 seconds': {
    objects: ['sso_replay_cache_retention'],
    check: async (f) => {
      await insertRefused(
        f.db,
        replay,
        { ...replayValues(f), retain_until: at(800) },
        violation('sso_replay_cache_retention'),
      )
      const consumed = at(-100)
      for (const retain_until of [consumed, at(-101)])
        await insertRefused(
          f.db,
          replay,
          { ...replayValues(f), consumed_at: consumed, retain_until },
          violation('sso_replay_cache_retention'),
          withoutTriggers,
        )
    },
    mutants: [
      dropConstraint(replay, 'sso_replay_cache_retention'),
      edit(
        'retention may end as it starts',
        'retain_until > consumed_at AND retain_until',
        'retain_until >= consumed_at AND retain_until',
      ),
      edit(
        'retention has no upper bound',
        " AND retain_until <= consumed_at + interval '720 seconds'",
        '',
      ),
    ],
  },
  'replay entries are consumed now and retained from then on': {
    objects: ['sso_replay_cache_starts_retained'],
    check: async (f) => {
      for (const values of [
        { consumed_at: at(60), retain_until: at(600) },
        { consumed_at: at(-300), retain_until: at(-1) },
      ])
        await insertRefused(
          f.db,
          replay,
          { ...replayValues(f), ...values },
          violation('sso_replay_cache_starts_retained'),
        )
    },
    mutants: [
      silence('sso_replay_cache_starts_retained'),
      edit(
        'entries may be consumed in the future',
        'IF NEW.consumed_at > clock_timestamp() OR NEW.retain_until',
        'IF NEW.retain_until',
      ),
      edit('entries may start expired', ' OR NEW.retain_until <= clock_timestamp() THEN', ' THEN'),
    ],
  },
  'replay entries are immutable': {
    objects: ['sso_replay_cache_immutable', 'sso_replay_cache_guard'],
    check: async (f) => {
      const entry = await insert(f.db, replay, replayValues(f))
      for (const values of [{ retain_until: at(60) }, { key_digest: digest() }])
        await updateRefused(
          f.db,
          replay,
          { provider_id: entry.provider_id, kind: entry.kind, key_digest: entry.key_digest },
          values,
          violation('sso_replay_cache_immutable'),
        )
    },
    mutants: [silence('sso_replay_cache_immutable'), dropTrigger(replay, 'sso_replay_cache_guard')],
  },
  'replay entries are kept until their retention ends': {
    objects: ['sso_replay_cache_retained'],
    check: async (f) => {
      const live = await insert(f.db, replay, replayValues(f))
      await refused(
        f.db,
        'DELETE FROM sso_replay_cache WHERE key_digest=$1',
        [live.key_digest],
        violation('sso_replay_cache_retained'),
      )
      const ended = await seeded(f.db, replay, {
        ...replayValues(f),
        consumed_at: at(-700),
        retain_until: at(-60),
      })
      await tried(f.db, 'DELETE FROM sso_replay_cache WHERE key_digest=$1', [ended.key_digest])
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, replay, { organization_id: f.team })).toBe(0)
    },
    mutants: [
      silence('sso_replay_cache_retained'),
      edit(
        "entries outlast their team's deletion",
        'IF OLD.retain_until > clock_timestamp()\n     AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN',
        'IF OLD.retain_until > clock_timestamp() THEN',
      ),
    ],
  },
}

// ---------------------------------------------------------------------------------------
// Browser proofs and delegation bindings
// ---------------------------------------------------------------------------------------

/** One proof and one binding with these values, each expected to be refused. */
async function bothRefused(
  f: IdentityFixture,
  values: Row,
  expected: { code: string; constraint: string },
) {
  await insertRefused(f.db, proofs, { ...proofValues(f), ...values }, expected)
  await insertRefused(
    f.db,
    bindings,
    { ...bindingValues(f, { api_key_id: await memberKey(f) }), ...values },
    expected,
  )
}
const domainReliance = {
  retired: 'AND (d.retired_at IS NOT NULL OR d.verified_at IS NULL',
  unverified: 'd.verified_at IS NULL OR d.verification_expires_at',
  lapsed: ' OR d.verification_expires_at <= clock_timestamp()\n           OR d.generation',
  generation: '\n           OR d.generation <> NEW.domain_generation',
  served:
    '\n           OR NOT EXISTS (\n             SELECT FROM public.sso_provider_domains\n             WHERE provider_id = NEW.provider_id AND domain_id = NEW.domain_id\n           ))',
}
const credentialRule = {
  owner: '("referenceId" <> NEW.user_id::text\n           OR lower(',
  team: "\n           OR lower(metadata::jsonb ->> 'organizationId') IS DISTINCT FROM NEW.organization_id::text)",
  grant: 'AND (user_id <> NEW.user_id OR organization_id <> NEW.organization_id)\n  ) THEN',
}

const proofProtections: Record<string, IdentityProtection> = {
  'browser proof IDs are unique': {
    objects: ['sso_browser_proofs_pkey', 'sso_browser_proofs_id_not_null'],
    check: async (f) => {
      const proof = await insert(f.db, proofs, proofValues(f))
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), id: proof.id },
        duplicate('sso_browser_proofs_pkey'),
      )
    },
    mutants: [dropConstraint(proofs, 'sso_browser_proofs_pkey')],
  },
  "a proof belongs to an existing membership, and the member's removal ends it": {
    objects: ['sso_browser_proofs_member_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), member_id: randomUUID() },
        foreignKey('sso_browser_proofs_member_id_fkey'),
      )
      await insert(f.db, proofs, proofValues(f))
      await accepted(f.db, 'DELETE FROM auth.member WHERE id=$1', [f.memberMember])
      expect(await count(f.db, proofs, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(proofs, 'sso_browser_proofs_member_id_fkey')],
  },
  'a proof belongs to an existing session, and logout ends it': {
    objects: ['sso_browser_proofs_session_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), session_id: randomUUID() },
        foreignKey('sso_browser_proofs_session_id_fkey'),
      )
      await insert(f.db, proofs, proofValues(f))
      await accepted(f.db, 'DELETE FROM auth.session WHERE id=$1', [f.sessions[f.member]])
      expect(await count(f.db, proofs, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(proofs, 'sso_browser_proofs_session_id_fkey')],
  },
  "a proof relies on its person's link at its provider in its team": {
    objects: ['sso_browser_proofs_link'],
    check: async (f) => {
      const adminLink = await link(f, f.admin)
      for (const values of [{ link_id: adminLink.id }, { link_id: randomUUID() }])
        await insertRefused(
          f.db,
          proofs,
          { ...proofValues(f), ...values },
          foreignKey('sso_browser_proofs_link'),
        )
    },
    mutants: [dropConstraint(proofs, 'sso_browser_proofs_link')],
  },
  'a proof relies on a claim of its own team': {
    objects: ['sso_browser_proofs_domain'],
    check: async (f) => {
      for (const domain_id of [f.otherDomain.id, randomUUID()])
        await insertRefused(
          f.db,
          proofs,
          { ...proofValues(f), domain_id },
          foreignKey('sso_browser_proofs_domain'),
        )
    },
    mutants: [dropConstraint(proofs, 'sso_browser_proofs_domain')],
  },
  'proofs last at most ssoProofLifetime': {
    objects: ['sso_browser_proofs_lifetime'],
    check: async (f) => {
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), expires_at: at(8 * HOUR + 120) },
        violation('sso_browser_proofs_lifetime'),
      )
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), created_at: at(-60), expires_at: at(-61) },
        violation('sso_browser_proofs_lifetime'),
        withoutTriggers,
      )
    },
    mutants: [
      dropConstraint(proofs, 'sso_browser_proofs_lifetime'),
      edit(
        'proofs last a day',
        "expires_at <= created_at + interval '28800 seconds'",
        "expires_at <= created_at + interval '86400 seconds'",
      ),
      edit(
        'proofs may end as they start',
        "expires_at > created_at AND expires_at <= created_at + interval '28800 seconds'",
        "expires_at <= created_at + interval '28800 seconds'",
      ),
    ],
  },
  'binding IDs are unique': {
    objects: ['sso_delegation_bindings_pkey', 'sso_delegation_bindings_id_not_null'],
    check: async (f) => {
      const binding = await insert(
        f.db,
        bindings,
        bindingValues(f, { api_key_id: await memberKey(f) }),
      )
      await insertRefused(
        f.db,
        bindings,
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), id: binding.id },
        duplicate('sso_delegation_bindings_pkey'),
      )
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_pkey')],
  },
  "a binding belongs to an existing membership, and the member's removal ends it": {
    objects: ['sso_delegation_bindings_member_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        bindings,
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), member_id: randomUUID() },
        foreignKey('sso_delegation_bindings_member_id_fkey'),
      )
      await insert(f.db, bindings, bindingValues(f, { api_key_id: await memberKey(f) }))
      await accepted(f.db, 'DELETE FROM auth.member WHERE id=$1', [f.memberMember])
      expect(await count(f.db, bindings, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_member_id_fkey')],
  },
  'a binding binds an existing API key and ends with it': {
    objects: ['sso_delegation_bindings_api_key_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        bindings,
        bindingValues(f, { api_key_id: randomUUID() }),
        foreignKey('sso_delegation_bindings_api_key_id_fkey'),
      )
      const key = await memberKey(f)
      await insert(f.db, bindings, bindingValues(f, { api_key_id: key }))
      await accepted(f.db, 'DELETE FROM auth.apikey WHERE id=$1', [key])
      expect(await count(f.db, bindings, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_api_key_id_fkey')],
  },
  'a binding binds an existing MCP OAuth grant and ends with it': {
    objects: ['sso_delegation_bindings_oauth_grant_id_fkey'],
    check: async (f) => {
      await insertRefused(
        f.db,
        bindings,
        bindingValues(f, { oauth_grant_id: randomUUID() }),
        foreignKey('sso_delegation_bindings_oauth_grant_id_fkey'),
      )
      const grant = await oauthGrant(f.db, f.member, f.team)
      await insert(f.db, bindings, bindingValues(f, { oauth_grant_id: grant }))
      await accepted(f.db, 'DELETE FROM mcp_oauth_grants WHERE id=$1', [grant])
      expect(await count(f.db, bindings, { user_id: f.member })).toBe(0)
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_oauth_grant_id_fkey')],
  },
  'one binding per API key': {
    objects: ['sso_delegation_bindings_one_per_api_key'],
    check: async (f) => {
      const key = await memberKey(f)
      await insert(f.db, bindings, bindingValues(f, { api_key_id: key }))
      await insertRefused(
        f.db,
        bindings,
        bindingValues(f, { api_key_id: key }),
        duplicate('sso_delegation_bindings_one_per_api_key'),
      )
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_one_per_api_key')],
  },
  'one binding per MCP OAuth grant': {
    objects: ['sso_delegation_bindings_one_per_oauth_grant'],
    check: async (f) => {
      const grant = await oauthGrant(f.db, f.member, f.team)
      await insert(f.db, bindings, bindingValues(f, { oauth_grant_id: grant }))
      await insertRefused(
        f.db,
        bindings,
        bindingValues(f, { oauth_grant_id: grant }),
        duplicate('sso_delegation_bindings_one_per_oauth_grant'),
      )
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_one_per_oauth_grant')],
  },
  'a binding binds exactly one credential': {
    objects: ['sso_delegation_bindings_credential_kind'],
    check: async (f) => {
      const grant = await oauthGrant(f.db, f.member, f.team)
      for (const values of [
        bindingValues(f, { api_key_id: await memberKey(f) }),
        bindingValues(f, { oauth_grant_id: grant }),
      ])
        await triedInsert(f.db, bindings, values)
      for (const values of [
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), api_key_id: null },
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), oauth_grant_id: grant },
      ])
        await insertRefused(
          f.db,
          bindings,
          values,
          violation('sso_delegation_bindings_credential_kind'),
        )
    },
    mutants: [
      dropConstraint(bindings, 'sso_delegation_bindings_credential_kind'),
      edit(
        'a binding may bind nothing',
        'num_nonnulls(api_key_id, oauth_grant_id) = 1',
        'num_nonnulls(api_key_id, oauth_grant_id) <= 1',
      ),
      edit(
        'a binding may bind both',
        'num_nonnulls(api_key_id, oauth_grant_id) = 1',
        'num_nonnulls(api_key_id, oauth_grant_id) >= 1',
      ),
    ],
  },
  "a binding relies on its person's link at its provider in its team": {
    objects: ['sso_delegation_bindings_link'],
    check: async (f) => {
      const adminLink = await link(f, f.admin)
      for (const link_id of [adminLink.id, randomUUID()])
        await insertRefused(
          f.db,
          bindings,
          { ...bindingValues(f, { api_key_id: await memberKey(f) }), link_id },
          foreignKey('sso_delegation_bindings_link'),
        )
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_link')],
  },
  'a binding relies on a claim of its own team': {
    objects: ['sso_delegation_bindings_domain'],
    check: async (f) => {
      for (const domain_id of [f.otherDomain.id, randomUUID()])
        await insertRefused(
          f.db,
          bindings,
          { ...bindingValues(f, { api_key_id: await memberKey(f) }), domain_id },
          foreignKey('sso_delegation_bindings_domain'),
        )
    },
    mutants: [dropConstraint(bindings, 'sso_delegation_bindings_domain')],
  },
  'bindings last at most ssoDelegationLifetime': {
    objects: ['sso_delegation_bindings_lifetime'],
    check: async (f) => {
      await insertRefused(
        f.db,
        bindings,
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), expires_at: at(30 * DAY + 120) },
        violation('sso_delegation_bindings_lifetime'),
      )
      await insertRefused(
        f.db,
        bindings,
        {
          ...bindingValues(f, { api_key_id: randomUUID() }),
          created_at: at(-60),
          expires_at: at(-61),
        },
        violation('sso_delegation_bindings_lifetime'),
        withoutTriggers,
      )
    },
    mutants: [
      dropConstraint(bindings, 'sso_delegation_bindings_lifetime'),
      edit(
        'bindings last 31 days',
        "expires_at <= created_at + interval '2592000 seconds'",
        "expires_at <= created_at + interval '2678400 seconds'",
      ),
      edit(
        'bindings may end as they start',
        "expires_at > created_at AND expires_at <= created_at + interval '2592000 seconds'",
        "expires_at <= created_at + interval '2592000 seconds'",
      ),
    ],
  },
  'proofs and bindings are immutable; revoking one deletes it': {
    objects: [
      'sso_reliance_immutable',
      'sso_browser_proofs_reliance',
      'sso_delegation_bindings_reliance',
    ],
    check: async (f) => {
      const proof = await insert(f.db, proofs, proofValues(f))
      const binding = await insert(
        f.db,
        bindings,
        bindingValues(f, { api_key_id: await memberKey(f) }),
      )
      for (const [table, row] of [
        [proofs, proof],
        [bindings, binding],
      ] as const) {
        for (const values of [{ expires_at: at(3600) }, { domain_generation: 2 }])
          await updateRefused(f.db, table, byId(row), values, violation('sso_reliance_immutable'))
        await tried(f.db, `DELETE FROM ${table} WHERE id=$1`, [row.id])
      }
    },
    mutants: [
      silence('sso_reliance_immutable'),
      dropTrigger(proofs, 'sso_browser_proofs_reliance'),
      dropTrigger(bindings, 'sso_delegation_bindings_reliance'),
    ],
  },
  'proofs and bindings start now and unexpired': {
    objects: ['sso_reliance_live'],
    check: async (f) => {
      for (const values of [
        { created_at: at(120), expires_at: at(3600) },
        { created_at: at(-7200), expires_at: at(-60) },
      ])
        await bothRefused(f, values, violation('sso_reliance_live'))
    },
    mutants: [
      silence('sso_reliance_live'),
      editFunction(
        'guard_sso_reliance',
        'they may start in the future',
        'NEW.created_at > clock_timestamp() OR ',
        '',
      ),
      editFunction(
        'guard_sso_reliance',
        'they may start expired',
        ' OR NEW.expires_at <= clock_timestamp() THEN',
        ' THEN',
      ),
    ],
  },
  "they belong to the person's membership of the team": {
    objects: ['sso_reliance_member'],
    check: async (f) => {
      const elsewhere = (
        await f.db.query<{ id: string }>(
          `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
          VALUES ($1,$2,'member',now()) RETURNING id`,
          [f.otherTeam, f.member],
        )
      ).rows[0]?.id
      for (const member_id of [f.adminMember, elsewhere, f.otherOwnerMember])
        await bothRefused(f, { member_id }, violation('sso_reliance_member'))
    },
    mutants: [
      silence('sso_reliance_member'),
      edit(
        "any of the person's memberships",
        '("organizationId" <> NEW.organization_id OR "userId" <> NEW.user_id)',
        '("userId" <> NEW.user_id)',
      ),
      edit(
        "another person's membership of the team",
        '("organizationId" <> NEW.organization_id OR "userId" <> NEW.user_id)',
        '("organizationId" <> NEW.organization_id)',
      ),
    ],
  },
  'they rely on an enabled provider': {
    objects: ['sso_reliance_provider'],
    check: async (f) => {
      await f.db.query('UPDATE sso_providers SET enabled=false WHERE id=$1', [f.provider.id])
      await bothRefused(f, {}, violation('sso_reliance_provider'))
      await f.db.query('UPDATE sso_providers SET retired_at=now() WHERE id=$1', [f.provider.id])
      await bothRefused(f, {}, violation('sso_reliance_provider'))
    },
    mutants: [silence('sso_reliance_provider')],
  },
  'they rely on the current generation of a live link': {
    objects: ['sso_reliance_link'],
    check: async (f) => {
      await bothRefused(f, { link_generation: 2 }, violation('sso_reliance_link'))
      // A live link at a later generation: only that generation counts.
      const adminLink = await link(f, f.admin)
      await f.db.query('UPDATE sso_identity_links SET generation=2 WHERE id=$1', [adminLink.id])
      const admin = {
        user_id: f.admin,
        member_id: f.adminMember,
        session_id: f.sessions[f.admin],
        link_id: adminLink.id,
      }
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), ...admin, link_generation: 1 },
        violation('sso_reliance_link'),
      )
      await triedInsert(f.db, proofs, { ...proofValues(f), ...admin, link_generation: 2 })
      // A retired link, even at its retired generation.
      const retired = await retire(f, f.memberLink)
      await bothRefused(f, { link_generation: retired.generation }, violation('sso_reliance_link'))
    },
    mutants: [
      silence('sso_reliance_link'),
      edit(
        'retired links count',
        'AND (retired_at IS NOT NULL OR generation <> NEW.link_generation)',
        'AND (generation <> NEW.link_generation)',
      ),
      edit(
        'any link generation counts',
        'AND (retired_at IS NOT NULL OR generation <> NEW.link_generation)',
        'AND (retired_at IS NOT NULL)',
      ),
    ],
  },
  "they record the team's current trust generation": {
    objects: ['sso_reliance_trust_generation'],
    check: async (f) => {
      // Without a policy the team is at generation 1.
      await bothRefused(f, { trust_generation: 2 }, violation('sso_reliance_trust_generation'))
      await insert(f.db, 'sso_policies', { organization_id: f.team, trust_generation: 3 })
      for (const trust_generation of [1, 2, 4])
        await bothRefused(f, { trust_generation }, violation('sso_reliance_trust_generation'))
      await triedInsert(f.db, proofs, { ...proofValues(f), trust_generation: 3 })
    },
    mutants: [
      silence('sso_reliance_trust_generation'),
      edit(
        'any generation without a policy',
        'WHERE organization_id = NEW.organization_id), 1\n  ) THEN',
        'WHERE organization_id = NEW.organization_id), NEW.trust_generation\n  ) THEN',
      ),
    ],
  },
  'they rely on the current, unexpired generation of a claim the provider serves': {
    objects: ['sso_reliance_domain'],
    check: async (f) => {
      const pending = await servedDomain(f, pendingDomainValues(f.team))
      const retired = await servedDomain(f, claimedDomainValues(f.team))
      await f.db.query('UPDATE sso_domains SET retired_at=now() WHERE id=$1', [retired.id])
      const unserved = await insert(f.db, 'sso_domains', claimedDomainValues(f.team))
      for (const domain of [pending, retired, unserved])
        await bothRefused(
          f,
          { domain_id: domain.id, domain_generation: 1 },
          violation('sso_reliance_domain'),
        )
      // A lapsed claim; a browser proof also outlives its verification, so only a binding
      // tells the claim check apart.
      const lapsed = await servedDomain(f, lapsedDomainValues(f.team))
      await insertRefused(
        f.db,
        bindings,
        { ...bindingValues(f, { api_key_id: await memberKey(f) }), domain_id: lapsed.id },
        violation('sso_reliance_domain'),
      )
      // The claim at its next generation: only that generation counts.
      await f.db.query(
        `UPDATE sso_domains SET generation=2, challenge_digest=$2, challenge_expires_at=$3,
          verified_at=NULL, verification_expires_at=NULL WHERE id=$1`,
        [f.domain.id, digest(), at(DAY)],
      )
      await f.db.query(
        'UPDATE sso_domains SET verified_at=now(), verification_expires_at=$2 WHERE id=$1',
        [f.domain.id, at(6 * DAY)],
      )
      for (const domain_generation of [1, 3])
        await bothRefused(f, { domain_generation }, violation('sso_reliance_domain'))
      await triedInsert(f.db, proofs, { ...proofValues(f), domain_generation: 2 })
    },
    mutants: [
      silence('sso_reliance_domain'),
      edit('retired claims count', domainReliance.retired, 'AND (d.verified_at IS NULL'),
      edit('pending claims count', domainReliance.unverified, 'd.verification_expires_at'),
      edit('lapsed claims count', domainReliance.lapsed, '\n           OR d.generation'),
      edit('any claim generation counts', domainReliance.generation, ''),
      edit('claims the provider does not serve count', domainReliance.served, ')'),
    ],
  },
  "a proof belongs to its person's session and ends with it": {
    objects: ['sso_browser_proofs_session', 'sso_browser_proofs_guard'],
    check: async (f) => {
      const short = await session(f.db, f.member, at(HOUR))
      for (const values of [
        { session_id: f.sessions[f.admin] },
        { session_id: short, expires_at: at(2 * HOUR) },
      ])
        await insertRefused(
          f.db,
          proofs,
          { ...proofValues(f), ...values },
          violation('sso_browser_proofs_session'),
        )
      await triedInsert(f.db, proofs, {
        ...proofValues(f),
        session_id: short,
        expires_at: at(HOUR - 60),
      })
    },
    mutants: [
      silence('sso_browser_proofs_session'),
      edit(
        'proofs may outlive their session',
        '("userId" <> NEW.user_id OR "expiresAt" < NEW.expires_at)',
        '("userId" <> NEW.user_id)',
      ),
      dropTrigger(proofs, 'sso_browser_proofs_guard'),
    ],
  },
  'a proof ends no later than the claim verification it relied on': {
    objects: ['sso_browser_proofs_domain_deadline'],
    check: async (f) => {
      const domain = await servedDomain(f, {
        ...claimedDomainValues(f.team),
        verification_expires_at: at(HOUR),
      })
      await insertRefused(
        f.db,
        proofs,
        { ...proofValues(f), domain_id: domain.id, expires_at: at(2 * HOUR) },
        violation('sso_browser_proofs_domain_deadline'),
      )
      await triedInsert(f.db, proofs, {
        ...proofValues(f),
        domain_id: domain.id,
        expires_at: at(HOUR - 60),
      })
    },
    mutants: [silence('sso_browser_proofs_domain_deadline')],
  },
  "a binding binds its person's own credential for the same team": {
    objects: ['sso_delegation_bindings_credential', 'sso_delegation_bindings_guard'],
    check: async (f) => {
      for (const credential of [
        { api_key_id: await apiKey(f.db, f.admin, f.team) },
        { api_key_id: await apiKey(f.db, f.member, f.otherTeam) },
        { api_key_id: await apiKey(f.db, f.member, null) },
        { oauth_grant_id: await oauthGrant(f.db, f.admin, f.team) },
        { oauth_grant_id: await oauthGrant(f.db, f.member, f.otherTeam) },
      ])
        await insertRefused(
          f.db,
          bindings,
          bindingValues(f, credential),
          violation('sso_delegation_bindings_credential'),
        )
      await triedInsert(f.db, bindings, bindingValues(f, { api_key_id: await memberKey(f) }))
      await triedInsert(
        f.db,
        bindings,
        bindingValues(f, { oauth_grant_id: await oauthGrant(f.db, f.member, f.team) }),
      )
    },
    mutants: [
      silence('sso_delegation_bindings_credential'),
      edit("another person's API key", credentialRule.owner, '(lower('),
      edit("another team's or a personal API key", credentialRule.team, ')'),
      edit('any MCP OAuth grant', credentialRule.grant, 'AND false\n  ) THEN'),
      dropTrigger(bindings, 'sso_delegation_bindings_guard'),
    ],
  },
  'a binding ends no later than its API key': {
    objects: ['sso_delegation_bindings_credential_deadline'],
    check: async (f) => {
      const key = await apiKey(f.db, f.member, f.team, at(DAY))
      await insertRefused(
        f.db,
        bindings,
        { ...bindingValues(f, { api_key_id: key }), expires_at: at(2 * DAY) },
        violation('sso_delegation_bindings_credential_deadline'),
      )
      await triedInsert(f.db, bindings, {
        ...bindingValues(f, { api_key_id: key }),
        expires_at: at(DAY - 60),
      })
    },
    mutants: [silence('sso_delegation_bindings_credential_deadline')],
  },
}

// ---------------------------------------------------------------------------------------
// Lookup indexes and required columns
// ---------------------------------------------------------------------------------------

const lookupIndexes = [
  'CREATE INDEX sso_attempts_session_id ON public.sso_attempts USING btree (session_id)',
  'CREATE INDEX sso_attempts_step_up_link_id ON public.sso_attempts USING btree (step_up_link_id)',
  'CREATE INDEX sso_browser_proofs_domain_id ON public.sso_browser_proofs USING btree (domain_id)',
  'CREATE INDEX sso_browser_proofs_link_id ON public.sso_browser_proofs USING btree (link_id)',
  'CREATE INDEX sso_browser_proofs_member_id ON public.sso_browser_proofs USING btree (member_id)',
  'CREATE INDEX sso_browser_proofs_session_id ON public.sso_browser_proofs USING btree (session_id)',
  'CREATE INDEX sso_delegation_bindings_domain_id ON public.sso_delegation_bindings USING btree (domain_id)',
  'CREATE INDEX sso_delegation_bindings_link_id ON public.sso_delegation_bindings USING btree (link_id)',
  'CREATE INDEX sso_delegation_bindings_member_id ON public.sso_delegation_bindings USING btree (member_id)',
  'CREATE INDEX sso_identity_links_user_id ON public.sso_identity_links USING btree (user_id)',
]
const lookupIndexNames = lookupIndexes.map((definition) => definition.split(' ')[2] as string)

const indexProtections: Record<string, IdentityProtection> = {
  'session, membership, link, claim and account lookups for cascades are indexed': {
    objects: lookupIndexNames,
    check: async (f) => {
      const { rows } = await f.db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)
        ORDER BY indexname`,
        [lookupIndexNames],
      )
      expect(rows.map(({ indexdef }) => indexdef)).toEqual(lookupIndexes)
    },
    mutants: lookupIndexNames.map(dropIndex),
  },
}

/** Every NOT NULL column outside a primary key, with a complete row for its table. */
const requiredColumns: Record<IdentityTable, string[]> = {
  sso_identity_links: [
    'organization_id',
    'provider_id',
    'issuer',
    'subject',
    'user_id',
    'generation',
    'proven_email',
    'email_proven_at',
    'created_at',
  ],
  sso_attempts: [
    'kind',
    'organization_id',
    'browser_binding_digest',
    'operation',
    'input_digest',
    'requires_mailbox',
    'requires_sso',
    'created_at',
    'expires_at',
  ],
  sso_mailbox_tokens: ['organization_id', 'attempt_id', 'issued_at', 'expires_at'],
  sso_replay_cache: ['organization_id', 'consumed_at', 'retain_until'],
  sso_browser_proofs: [
    'organization_id',
    'user_id',
    'member_id',
    'session_id',
    'provider_id',
    'link_id',
    'link_generation',
    'trust_generation',
    'domain_id',
    'domain_generation',
    'created_at',
    'expires_at',
  ],
  sso_delegation_bindings: [
    'organization_id',
    'user_id',
    'member_id',
    'provider_id',
    'link_id',
    'link_generation',
    'trust_generation',
    'domain_id',
    'domain_generation',
    'created_at',
    'expires_at',
  ],
}
const completeRow = (f: IdentityFixture, table: IdentityTable): Row => {
  const created = { created_at: at(0) }
  switch (table) {
    case 'sso_identity_links':
      return { ...linkValues(f, f.admin), generation: 1, ...created }
    case 'sso_attempts':
      return { ...freshProofValues(f), requires_sso: false, ...created }
    case 'sso_mailbox_tokens':
      return { ...tokenValues({ organization_id: f.team, id: randomUUID() }), issued_at: at(0) }
    case 'sso_replay_cache':
      return { ...replayValues(f), consumed_at: at(0) }
    case 'sso_browser_proofs':
      return { ...proofValues(f), ...created }
    case 'sso_delegation_bindings':
      return { ...bindingValues(f, { api_key_id: randomUUID() }), ...created }
  }
}
const notNullProtections: Record<string, IdentityProtection> = Object.fromEntries(
  Object.entries(requiredColumns).flatMap(([table, columns]) =>
    columns.map((column) => [
      `${table}.${column} is required`,
      {
        objects: [`${table}_${column}_not_null`],
        check: async (f: IdentityFixture) => {
          const row = completeRow(f, table as IdentityTable)
          // The complete row is valid; with the column missing only NOT NULL refuses it.
          await insertAccepted(f.db, table, row, withoutTriggers)
          await insertRefused(
            f.db,
            table,
            { ...row, [column]: null },
            { code: '23502', column },
            withoutTriggers,
          )
        },
        mutants: [
          append(
            `${table}.${column} may be null`,
            `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;`,
          ),
        ],
      } satisfies IdentityProtection,
    ]),
  ),
)

export const identityProtections: Record<string, IdentityProtection> = {
  ...linkProtections,
  ...attemptProtections,
  ...tokenProtections,
  ...replayProtections,
  ...proofProtections,
  ...indexProtections,
  ...notNullProtections,
}

/**
 * The whole suite on one database, for checkConstraintCoverage: every check in its own
 * rolled-back transaction, then the link-identity and replay-key races (which commit their own
 * teams). Throws on the first failing assertion.
 */
export async function assertIdentityProtections(pool: pg.Pool) {
  for (const protection of Object.values(identityProtections))
    await inRolledBackTransaction(pool, async (db) => protection.check(await identityFixture(db)))
  await checkLinkIdentityRace(pool)
  await checkReplayRace(pool)
}
