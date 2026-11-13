import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import {
  bookingRoutingValues,
  formValues,
  insertRow,
  quote,
  type RoutingFixture,
  receiptValues,
  routingFixture,
  versionValues,
} from './routing-storage-fixtures.ts'
import { readRoutingStorageLimits } from './routing-storage-limits.ts'
import { checkQuotaRace, checkSharedOrganizationLocks } from './routing-storage-quota-races.ts'

export interface Protection {
  check: (f: RoutingFixture) => Promise<void>
  break: (source: string) => string
}
const checkViolation = { code: '23514' }
const fkViolation = { code: '23503' }
const drop = (table: string, name: string) => (source: string) =>
  `${source}\nALTER TABLE ${table} DROP CONSTRAINT ${name};\n`
const noTrigger = (table: string, name: string) => (source: string) =>
  `${source}\nDROP TRIGGER ${name} ON ${table};\n`
export const routingProtections: Record<string, Protection> = {
  'version form organization FK': {
    check: async (f) => {
      await expect(
        insertRow(f.pool, 'routing_form_versions', {
          ...versionValues(f),
          organization_id: f.otherOrganization,
          version_number: 2,
        }),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_form_versions', 'routing_form_versions_organization_id_form_id_fkey'),
  },
  'published pointer organization and form FK': {
    check: async (f) => {
      await expect(
        f.pool.query('UPDATE routing_forms SET published_version_id=$1 WHERE id=$2', [
          f.otherVersion,
          f.form,
        ]),
      ).rejects.toMatchObject(fkViolation)
      const sibling = await insertRow(f.pool, 'routing_forms', formValues(f))
      const version = await insertRow(f.pool, 'routing_form_versions', {
        ...versionValues(f),
        form_id: sibling,
      })
      await expect(
        f.pool.query('UPDATE routing_forms SET published_version_id=$1 WHERE id=$2', [
          version,
          f.form,
        ]),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_forms', 'routing_forms_published_version_fk'),
  },
  'dependency organization FK': {
    check: async (f) => {
      await expect(
        insertRow(f.pool, 'routing_target_dependencies', {
          organization_id: f.otherOrganization,
          version_id: f.version,
          rule_id: 'fallback',
          event_type_id: f.event,
        }),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop(
      'routing_target_dependencies',
      'routing_target_dependencies_organization_id_version_id_fkey',
    ),
  },
  'receipt version organization and form FK': {
    check: async (f) => {
      await expect(
        insertRow(f.pool, 'routing_receipts', {
          ...receiptValues(f),
          organization_id: f.otherOrganization,
        }),
      ).rejects.toMatchObject(fkViolation)
      const sibling = await insertRow(f.pool, 'routing_forms', formValues(f))
      await expect(
        insertRow(f.pool, 'routing_receipts', {
          ...receiptValues(f),
          form_id: sibling,
        }),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_receipts', 'routing_receipts_organization_id_form_id_version_id_fkey'),
  },
  'receipt booking organization FK': {
    check: async (f) => {
      await expect(
        insertRow(f.pool, 'routing_receipts', {
          ...receiptValues(f),
          consumed_booking_id: f.otherBooking,
          answers_ciphertext: null,
        }),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_receipts', 'routing_receipts_consumed_booking_id_organization_id_fkey'),
  },
  'snapshot booking organization FK': {
    check: async (f) => {
      await expect(
        insertRow(f.pool, 'booking_routing', {
          ...bookingRoutingValues(f),
          booking_id: f.otherBooking,
        }),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('booking_routing', 'booking_routing_booking_id_organization_id_fkey'),
  },
  'non-archived form quota and archive frees capacity': {
    check: async (f) => {
      const max = readRoutingStorageLimits().forms_per_organization
      await f.pool.query(
        `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft)
        SELECT $1,'quota-' || n,$2,'{}' FROM generate_series(2,$3::int) n`,
        [f.organization, f.creator, max],
      )
      await expect(insertRow(f.pool, 'routing_forms', formValues(f))).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'routing_forms_quota',
      })
      await f.pool.query(
        'UPDATE routing_forms SET archived_at=now() WHERE organization_id=$1 AND slug=$2',
        [f.organization, `quota-${max}`],
      )
      await expect(insertRow(f.pool, 'routing_forms', formValues(f))).resolves.toEqual(
        expect.any(String),
      )
      await expect(insertRow(f.pool, 'routing_forms', formValues(f))).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'routing_forms_quota',
      })
    },
    break: (source) => source.replace('>= 100 THEN', '>= 101 THEN'),
  },
  'total retained form quota': {
    check: async (f) => {
      const max = readRoutingStorageLimits().total_forms_per_organization
      await f.pool.query(
        `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft,archived_at)
        SELECT $1,'total-' || n,$2,'{}',now() FROM generate_series(2,$3::int) n`,
        [f.organization, f.creator, max],
      )
      await expect(
        insertRow(f.pool, 'routing_forms', { ...formValues(f), archived_at: new Date() }),
      ).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'routing_forms_total_quota',
      })
    },
    break: (source) => source.replace('>= 1000 THEN', '>= 1001 THEN'),
  },
  'retained version quota per form': {
    check: async (f) => {
      const max = readRoutingStorageLimits().versions_per_form
      const sibling = await insertRow(f.pool, 'routing_forms', formValues(f))
      await insertRow(f.pool, 'routing_form_versions', { ...versionValues(f), form_id: sibling })
      await expect(
        f.pool.query(
          `INSERT INTO routing_form_versions
        (organization_id,form_id,version_number,questions,rules,fallback,published_by_user_id)
        SELECT $1,$2,n,'[]','[]','{}',$3 FROM generate_series(2,$4::int) n`,
          [f.organization, f.form, f.creator, max],
        ),
      ).resolves.toMatchObject({ rowCount: max - 1 })
      await expect(
        insertRow(f.pool, 'routing_form_versions', {
          ...versionValues(f),
          version_number: max + 1,
        }),
      ).rejects.toMatchObject({ ...checkViolation, constraint: 'routing_form_versions_quota' })
      await f.pool.query(
        'DELETE FROM routing_form_versions WHERE form_id=$1 AND version_number=$2',
        [f.form, max],
      )
      await insertRow(f.pool, 'routing_form_versions', {
        ...versionValues(f),
        version_number: max + 1,
      })
    },
    break: (source) =>
      source.replace('AND form_id = NEW.form_id) >= 1000', 'AND form_id = NEW.form_id) >= 1001'),
  },
  'immutable version updates': {
    check: async (f) => {
      for (const [column, value] of Object.entries({
        id: randomUUID(),
        organization_id: f.otherOrganization,
        form_id: f.otherForm,
        version_number: 2,
        questions: '[{"id":"new-question"}]',
        rules: '[{"id":"new-rule"}]',
        fallback: '{"kind":"message","message":"Changed"}',
        published_at: '2030-01-01T00:00Z',
        published_by_user_id: randomUUID(),
      }))
        await expect(
          f.pool.query(`UPDATE routing_form_versions SET ${quote(column)}=$1 WHERE id=$2`, [
            value,
            f.version,
          ]),
        ).rejects.toMatchObject({
          ...checkViolation,
          constraint: 'routing_form_versions_immutable',
        })
    },
    break: noTrigger('routing_form_versions', 'routing_form_versions_guard'),
  },
  'immutable form identity': {
    check: async (f) => {
      for (const [column, value] of Object.entries({
        id: randomUUID(),
        organization_id: f.otherOrganization,
        created_by_user_id: randomUUID(),
        created_at: '2020-01-01T00:00Z',
      }))
        await expect(
          f.pool.query(`UPDATE routing_forms SET ${quote(column)}=$1 WHERE id=$2`, [value, f.form]),
        ).rejects.toMatchObject({
          ...checkViolation,
          constraint: 'routing_forms_identity_immutable',
        })
    },
    break: noTrigger('routing_forms', 'routing_forms_guard'),
  },
  'immutable booking snapshot': {
    check: async (f) => {
      await insertRow(f.pool, 'booking_routing', bookingRoutingValues(f))
      for (const [column, value] of Object.entries({
        form_id: randomUUID(),
        version_id: randomUUID(),
        version_number: 2,
        questions: '[{"label":"Changed"}]',
        answers: '{"answer":"Changed"}',
        matched_rule_id: randomUUID(),
        resolved_rule_id: randomUUID(),
      }))
        await expect(
          f.pool.query(`UPDATE booking_routing SET ${quote(column)}=$1 WHERE booking_id=$2`, [
            value,
            f.booking,
          ]),
        ).rejects.toMatchObject({ ...checkViolation, constraint: 'booking_routing_immutable' })
    },
    break: noTrigger('booking_routing', 'booking_routing_guard'),
  },
  'current published version cannot be deleted': {
    check: async (f) => {
      await f.pool.query('UPDATE routing_forms SET published_version_id=$1 WHERE id=$2', [
        f.version,
        f.form,
      ])
      await expect(
        f.pool.query('DELETE FROM routing_form_versions WHERE id=$1', [f.version]),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_forms', 'routing_forms_published_version_fk'),
  },
  'live and consumed receipts retain versions': {
    check: async (f) => {
      const receipt = await insertRow(f.pool, 'routing_receipts', receiptValues(f))
      await expect(
        f.pool.query('DELETE FROM routing_form_versions WHERE id=$1', [f.version]),
      ).rejects.toMatchObject(fkViolation)
      await f.pool.query(
        'UPDATE routing_receipts SET consumed_booking_id=$1,answers_ciphertext=NULL WHERE id=$2',
        [f.booking, receipt],
      )
      await expect(
        f.pool.query('DELETE FROM routing_form_versions WHERE id=$1', [f.version]),
      ).rejects.toMatchObject(fkViolation)
    },
    break: drop('routing_receipts', 'routing_receipts_organization_id_form_id_version_id_fkey'),
  },
}

// Each separate SQL CHECK has a matching executable assertion and source-copy mutation.
const checks: [
  string,
  string,
  string,
  (f: RoutingFixture) => Record<string, unknown>,
  string,
  unknown,
][] = [
  ['draft container', 'routing_forms', 'routing_forms_draft_check', formValues, 'draft', '[]'],
  [
    'positive revision',
    'routing_forms',
    'routing_forms_draft_revision_check',
    formValues,
    'draft_revision',
    0,
  ],
  [
    'enabled publication',
    'routing_forms',
    'routing_forms_enabled_shape',
    formValues,
    'enabled',
    true,
  ],
  [
    'questions container',
    'routing_form_versions',
    'routing_form_versions_questions_check',
    versionValues,
    'questions',
    '{}',
  ],
  [
    'rules container',
    'routing_form_versions',
    'routing_form_versions_rules_check',
    versionValues,
    'rules',
    '{}',
  ],
  [
    'fallback container',
    'routing_form_versions',
    'routing_form_versions_fallback_check',
    versionValues,
    'fallback',
    '[]',
  ],
  [
    'receipt target container',
    'routing_receipts',
    'routing_receipts_resolved_target_check',
    receiptValues,
    'resolved_target',
    '[]',
  ],
  [
    'receipt expiry',
    'routing_receipts',
    'routing_receipts_expiry',
    receiptValues,
    'expires_at',
    '2000-01-01T00:00Z',
  ],
  [
    'consumed ciphertext erased',
    'routing_receipts',
    'routing_receipts_consumed_shape',
    receiptValues,
    'consumed_booking_id',
    'BOOKING',
  ],
  [
    'snapshot positive version',
    'booking_routing',
    'booking_routing_version_number_check',
    bookingRoutingValues,
    'version_number',
    0,
  ],
  [
    'snapshot question container',
    'booking_routing',
    'booking_routing_questions_check',
    bookingRoutingValues,
    'questions',
    '{}',
  ],
  [
    'snapshot answer container',
    'booking_routing',
    'booking_routing_answers_check',
    bookingRoutingValues,
    'answers',
    '[]',
  ],
]
for (const [name, table, constraint, values, column, value] of checks)
  routingProtections[name] = {
    check: async (f) => {
      await expect(
        insertRow(f.pool, table, {
          ...values(f),
          ...(table === 'routing_form_versions' ? { version_number: 2 } : {}),
          [column]: value === 'BOOKING' ? f.booking : value,
        }),
      ).rejects.toMatchObject({ ...checkViolation, constraint })
    },
    break: drop(table, constraint),
  }
const dependencyValues = (f: RoutingFixture) => ({
  organization_id: f.organization,
  version_id: f.version,
  rule_id: 'fallback',
  event_type_id: f.event,
})
const UUID_FORMAT = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const DIGEST_FORMAT = '^[0-9a-f]{64}$'
const FALLBACK = 'fallback'
const formats: [
  string,
  string,
  string,
  (f: RoutingFixture) => Record<string, unknown>,
  string,
  () => string,
  string | undefined,
][] = [
  [
    'receipt digest format',
    'routing_receipts',
    'token_hash',
    receiptValues,
    DIGEST_FORMAT,
    () => randomUUID().replaceAll('-', '').repeat(2),
    undefined,
  ],
  [
    'dependency rule identity',
    'routing_target_dependencies',
    'rule_id',
    dependencyValues,
    UUID_FORMAT,
    randomUUID,
    FALLBACK,
  ],
]
for (const table of ['routing_receipts', 'booking_routing'])
  for (const column of ['matched_rule_id', 'resolved_rule_id'])
    formats.push([
      `${table} ${column} identity`,
      table,
      column,
      table === 'routing_receipts' ? receiptValues : bookingRoutingValues,
      UUID_FORMAT,
      randomUUID,
      FALLBACK,
    ])
// pg_get_constraintdef renders each format CHECK in this canonical form. Pinning the whole
// definition rejects every widening of a quantifier or of the literal, including ones the
// probes below do not enumerate.
const formatDefinition = (column: string, pattern: string, literal: string | undefined) =>
  literal === undefined
    ? `CHECK ((${column} ~ '${pattern}'::text))`
    : `CHECK (((${column} = '${literal}'::text) OR (${column} ~ '${pattern}'::text)))`
// Each invalid value differs from a valid one only at an edge, in letter case or by one
// character in one group, so dropping either regex anchor, widening one quantifier,
// loosening the literal or dropping the whole CHECK admits at least one of them.
const edgeValues = (valid: string, literal: string | undefined) => {
  const groups = valid.split('-')
  const last = groups.length - 1
  const regroup = (index: number, group: string) =>
    groups.map((current, i) => (i === index ? group : current)).join('-')
  return [
    ...new Set([
      'malformed',
      valid.slice(1),
      `0${valid}`,
      `x${valid}`,
      `${valid}0`,
      `${valid}x`,
      `A${valid.slice(1)}`,
      // Last group one hex digit short (11 of 12, or 63 of 64) and one long (13, or 65).
      regroup(last, (groups[last] ?? '').slice(1)),
      regroup(last, `${groups[last]}0`),
      // Fourth UUID group with 3 and with 5 hex digits.
      ...(groups.length === 5
        ? [regroup(3, (groups[3] ?? '').slice(1)), regroup(3, `${groups[3]}0`)]
        : []),
      // Only the exact literal is accepted: no prefix, suffix or case variant.
      ...(literal === undefined
        ? []
        : [`${literal}x`, `x${literal}`, `${literal[0]?.toUpperCase()}${literal.slice(1)}`]),
    ]),
  ]
}
// Rewrites one column's CHECK inside one table; unchanged source fails the harness.
const rewriteFormat = (table: string, find: string, replacement: string) => (source: string) => {
  const start = source.indexOf(`CREATE TABLE ${table} (`)
  const end = source.indexOf('\n);', start)
  const body = source.slice(start, end)
  if (start < 0 || body.split(find).length !== 2) return source
  return `${source.slice(0, start)}${body.replace(find, () => replacement)}${source.slice(end)}`
}
const withoutAnchor = (table: string, column: string, pattern: string, anchor: '^' | '$') =>
  rewriteFormat(table, `${column} ~ '${pattern}'`, `${column} ~ '${pattern.replace(anchor, '')}'`)
for (const [name, table, column, values, pattern, valid, literal] of formats) {
  const constraint = `${table}_${column}_check`
  const check = async (f: RoutingFixture) => {
    const value = valid()
    for (const invalid of edgeValues(value, literal))
      await expect(
        insertRow(f.pool, table, { ...values(f), [column]: invalid }),
      ).rejects.toMatchObject({ ...checkViolation, constraint })
    // booking_routing has one row per booking, so its literal acceptance is covered by the
    // fixture rows other protections insert.
    if (literal !== undefined && table !== 'booking_routing')
      await insertRow(f.pool, table, { ...values(f), [column]: literal })
    await insertRow(f.pool, table, { ...values(f), [column]: value })
    const { rows } = await f.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
      [table, constraint],
    )
    expect(rows[0]?.definition).toBe(formatDefinition(column, pattern, literal))
  }
  routingProtections[name] = { check, break: drop(table, constraint) }
  routingProtections[`${name} start anchor`] = {
    check,
    break: withoutAnchor(table, column, pattern, '^'),
  }
  routingProtections[`${name} end anchor`] = {
    check,
    break: withoutAnchor(table, column, pattern, '$'),
  }
  const widened = (find: string, replacement: string) =>
    rewriteFormat(
      table,
      `${column} ~ '${pattern}'`,
      `${column} ~ '${pattern.replace(find, replacement)}'`,
    )
  routingProtections[`${name} last group length`] = {
    check,
    break: pattern === UUID_FORMAT ? widened('{12}$', '{11,12}$') : widened('{64}$', '{63,64}$'),
  }
  if (pattern === UUID_FORMAT)
    routingProtections[`${name} inner group length`] = {
      check,
      break: widened('-[0-9a-f]{4}-[0-9a-f]{12}$', '-[0-9a-f]{3,4}-[0-9a-f]{12}$'),
    }
  if (literal !== undefined)
    routingProtections[`${name} literal exact`] = {
      check,
      break: rewriteFormat(table, `${column} = '${literal}'`, `${column} LIKE '${literal}%'`),
    }
}
for (const [name, table, constraint, values] of [
  ['unique form slug', 'routing_forms', 'routing_forms_organization_id_slug_key', formValues],
  ['unique receipt digest', 'routing_receipts', 'routing_receipts_token_hash_key', receiptValues],
] as const)
  routingProtections[name] = {
    check: async (f) => {
      const row = values(f)
      await insertRow(f.pool, table, row)
      await expect(insertRow(f.pool, table, row)).rejects.toMatchObject({
        code: '23505',
        constraint,
      })
    },
    break: drop(table, constraint),
  }

routingProtections['positive version and monotonic sequence'] = {
  check: async (f) => {
    await expect(
      insertRow(f.pool, 'routing_form_versions', { ...versionValues(f), version_number: 0 }),
    ).rejects.toMatchObject({ code: '23514' })
  },
  break: (source) =>
    `${source.replace('IF NOT FOUND AND EXISTS', 'IF false AND NOT FOUND AND EXISTS')}\nALTER TABLE routing_form_versions DROP CONSTRAINT routing_form_versions_version_number_check;`,
}
routingProtections['version number never reused after cleanup'] = {
  check: async (f) => {
    await f.pool.query('DELETE FROM routing_form_versions WHERE id=$1', [f.version])
    await expect(
      insertRow(f.pool, 'routing_form_versions', versionValues(f)),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_form_versions_sequence' })
  },
  break: (source) => source.replace('IF NOT FOUND AND EXISTS', 'IF false AND NOT FOUND AND EXISTS'),
}
routingProtections['version high water mark cannot decrease'] = {
  check: async (f) => {
    await expect(
      f.pool.query('UPDATE routing_forms SET last_version_number=0 WHERE id=$1', [f.form]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_forms_version_sequence' })
  },
  break: noTrigger('routing_forms', 'routing_forms_guard'),
}
routingProtections['consumed evidence cannot be revived or replaced'] = {
  check: async (f) => {
    const id = await insertRow(f.pool, 'routing_receipts', {
      ...receiptValues(f),
      consumed_booking_id: f.booking,
      answers_ciphertext: null,
    })
    for (const [column, value] of Object.entries({
      consumed_booking_id: null,
    }))
      await expect(
        f.pool.query(`UPDATE routing_receipts SET ${quote(column)}=$1 WHERE id=$2`, [value, id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_consumed_immutable' })
  },
  break: noTrigger('routing_receipts', 'routing_receipts_guard'),
}
routingProtections['purged answers cannot return'] = {
  check: async (f) => {
    const id = await insertRow(f.pool, 'routing_receipts', receiptValues(f))
    await f.pool.query('UPDATE routing_receipts SET answers_ciphertext=NULL WHERE id=$1', [id])
    await expect(
      f.pool.query('UPDATE routing_receipts SET answers_ciphertext=$1 WHERE id=$2', [
        Buffer.from('synthetic'),
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_answers_purged' })
  },
  break: noTrigger('routing_receipts', 'routing_receipts_guard'),
}

routingProtections['receipt issuance bindings are immutable'] = {
  check: async (f) => {
    const id = await insertRow(f.pool, 'routing_receipts', receiptValues(f))
    for (const [column, value] of Object.entries({
      id: randomUUID(),
      organization_id: f.otherOrganization,
      form_id: f.otherForm,
      version_id: f.otherVersion,
      token_hash: 'b'.repeat(64),
      matched_rule_id: randomUUID(),
      resolved_rule_id: randomUUID(),
      resolved_target: '{"kind":"event","eventTypeId":"changed"}',
      created_at: '2020-01-01T00:00Z',
      expires_at: '2100-01-01T00:00Z',
    }))
      await expect(
        f.pool.query(`UPDATE routing_receipts SET ${quote(column)}=$1 WHERE id=$2`, [value, id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_issuance_immutable' })
  },
  break: noTrigger('routing_receipts', 'routing_receipts_guard'),
}
routingProtections['receipt answers cannot be replaced'] = {
  check: async (f) => {
    const id = await insertRow(f.pool, 'routing_receipts', receiptValues(f))
    await expect(
      f.pool.query('UPDATE routing_receipts SET answers_ciphertext=$1 WHERE id=$2', [
        Buffer.from('changed synthetic'),
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_answers_immutable' })
  },
  break: noTrigger('routing_receipts', 'routing_receipts_guard'),
}

routingProtections['form quota serialization'] = {
  check: (f) => checkQuotaRace(f, 'forms'),
  break: (source) =>
    source.replace(
      "PERFORM pg_advisory_xact_lock(hashtextextended('hourmere.routing-form-quota:' || NEW.organization_id::text, 0));",
      'PERFORM 1;',
    ),
}
routingProtections['version quota serialization'] = {
  check: (f) => checkQuotaRace(f, 'versions'),
  break: (source) =>
    source.replace(
      'UPDATE public.routing_forms SET last_version_number = NEW.version_number',
      'PERFORM id FROM public.routing_forms',
    ),
}

routingProtections['unique dependency version and rule'] = {
  check: async (f) => {
    const row = {
      organization_id: f.organization,
      version_id: f.version,
      rule_id: 'fallback',
      event_type_id: f.event,
    }
    await insertRow(f.pool, 'routing_target_dependencies', row)
    await expect(
      insertRow(f.pool, 'routing_target_dependencies', { ...row, event_type_id: randomUUID() }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'routing_target_dependencies_pkey' })
  },
  break: (source) =>
    source.replace(
      'PRIMARY KEY (version_id, rule_id)',
      'PRIMARY KEY (version_id, rule_id, event_type_id)',
    ),
}
routingProtections['one snapshot per booking'] = {
  check: async (f) => {
    await insertRow(f.pool, 'booking_routing', bookingRoutingValues(f))
    await expect(
      insertRow(f.pool, 'booking_routing', {
        ...bookingRoutingValues(f),
        answers: '{"changed":true}',
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'booking_routing_pkey' })
  },
  break: drop('booking_routing', 'booking_routing_pkey'),
}
routingProtections['booking deletion removes consumed receipt'] = {
  check: async (f) => {
    const id = await insertRow(f.pool, 'routing_receipts', {
      ...receiptValues(f),
      consumed_booking_id: f.booking,
      answers_ciphertext: null,
    })
    await expect(
      f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect((await f.pool.query('SELECT id FROM routing_receipts WHERE id=$1', [id])).rows).toEqual(
      [],
    )
  },
  break: (source) =>
    source.replace(
      'FOREIGN KEY (consumed_booking_id, organization_id)\n    REFERENCES bookings (id, organization_id) ON DELETE CASCADE',
      'FOREIGN KEY (consumed_booking_id, organization_id)\n    REFERENCES bookings (id, organization_id)',
    ),
}
routingProtections['consumed receipt cannot rebind same organization booking'] = {
  check: async (f) => {
    const booking = await insertRow(f.pool, 'bookings', {
      organization_id: f.organization,
      event_type_id: f.event,
      start_at: '2030-02-01T09:00Z',
      end_at: '2030-02-01T09:30Z',
      title: 'Second booking',
      source: 'web',
      status: 'confirmed',
    })
    const id = await insertRow(f.pool, 'routing_receipts', {
      ...receiptValues(f),
      consumed_booking_id: f.booking,
      answers_ciphertext: null,
    })
    await expect(
      f.pool.query('UPDATE routing_receipts SET consumed_booking_id=$1 WHERE id=$2', [booking, id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_consumed_immutable' })
  },
  break: (source) =>
    source.replace(
      'OLD.consumed_booking_id IS NOT NULL AND NEW IS DISTINCT FROM OLD',
      'OLD.consumed_booking_id IS NOT NULL AND NEW.consumed_booking_id IS NULL',
    ),
}
routingProtections['receipt expiry strictly follows creation'] = {
  check: async (f) => {
    await expect(
      insertRow(f.pool, 'routing_receipts', {
        ...receiptValues(f),
        created_at: '2030-01-01T00:00Z',
        expires_at: '2030-01-01T00:00Z',
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_receipts_expiry' })
  },
  break: (source) =>
    source.replace('CHECK (expires_at > created_at)', 'CHECK (expires_at >= created_at)'),
}
const HEALTH_CODES = ['ok', 'unavailable', 'unknown']
const HEALTH_CHECK = "CHECK (health_code IN ('ok', 'unavailable', 'unknown'))"
const checkHealthVocabulary = async (f: RoutingFixture) => {
  for (const health_code of HEALTH_CODES)
    await insertRow(f.pool, 'routing_target_dependencies', {
      ...dependencyValues(f),
      rule_id: randomUUID(),
      health_code,
    })
  for (const health_code of ['anything goes', 'degraded', 'error', 'healthy', 'stale', 'OK', ''])
    await expect(
      insertRow(f.pool, 'routing_target_dependencies', { ...dependencyValues(f), health_code }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'routing_target_dependencies_health_code_check',
    })
  // Probes cannot enumerate every value a widened CHECK might admit; pin the exact set.
  const { rows } = await f.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'routing_target_dependencies'::regclass AND conname = $1`,
    ['routing_target_dependencies_health_code_check'],
  )
  expect(
    [...(rows[0]?.definition ?? '').matchAll(/'([^']*)'::text/g)].map(([, code]) => code).sort(),
  ).toEqual(HEALTH_CODES)
}
routingProtections['dependency health code vocabulary'] = {
  check: checkHealthVocabulary,
  break: drop('routing_target_dependencies', 'routing_target_dependencies_health_code_check'),
}
routingProtections['dependency health code vocabulary is exact'] = {
  check: checkHealthVocabulary,
  break: (source) =>
    source.replace(HEALTH_CHECK, HEALTH_CHECK.replace("'unknown'", "'unknown', 'paused'")),
}

const DEPENDENCY_IDENTITY = ['organization_id', 'version_id', 'rule_id', 'event_type_id']
const dependencyGuard = (columns: string[]) =>
  `IF ROW(${columns.map((column) => `NEW.${column}`).join(', ')})\n     IS DISTINCT FROM ROW(${columns.map((column) => `OLD.${column}`).join(', ')})`
const checkDependencyIdentity = async (f: RoutingFixture) => {
  await insertRow(f.pool, 'routing_target_dependencies', dependencyValues(f))
  const sibling = await insertRow(f.pool, 'routing_form_versions', {
    ...versionValues(f),
    version_number: 2,
  })
  // Every rewrite except the organization-only one satisfies all keys and foreign keys, so
  // only the guard rejects it; the BEFORE trigger also runs ahead of the organization FK.
  for (const change of [
    { organization_id: f.otherOrganization },
    { organization_id: f.otherOrganization, version_id: f.otherVersion },
    { version_id: sibling },
    { rule_id: randomUUID() },
    { event_type_id: randomUUID() },
  ]) {
    const assignments = Object.keys(change).map((column, i) => `${quote(column)}=$${i + 2}`)
    await expect(
      f.pool.query(
        `UPDATE routing_target_dependencies SET ${assignments.join(',')} WHERE version_id=$1`,
        [f.version, ...Object.values(change)],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'routing_target_dependencies_identity_immutable',
    })
  }
  await expect(
    f.pool.query(
      "UPDATE routing_target_dependencies SET health_code='ok',health_checked_at=now() WHERE version_id=$1",
      [f.version],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
}
routingProtections['dependency target identity immutable'] = {
  check: checkDependencyIdentity,
  break: noTrigger('routing_target_dependencies', 'routing_target_dependencies_guard'),
}
for (const column of DEPENDENCY_IDENTITY)
  routingProtections[`dependency identity guard covers ${column}`] = {
    check: checkDependencyIdentity,
    break: (source) =>
      source.replace(dependencyGuard(DEPENDENCY_IDENTITY), () =>
        dependencyGuard(DEPENDENCY_IDENTITY.filter((kept) => kept !== column)),
      ),
  }
routingProtections['form slug shape'] = {
  check: async (f) => {
    for (const slug of ['', 'Sales', '-sales', 'sales-', 'a'.repeat(65)])
      await expect(
        insertRow(f.pool, 'routing_forms', { ...formValues(f), slug }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'routing_forms_slug_check' })
  },
  break: drop('routing_forms', 'routing_forms_slug_check'),
}
// Backstops intentionally remain independently enforced even if sequence triggers regress.
for (const [name, table, trigger, constraint, values] of [
  [
    'nonnegative high water backstop',
    'routing_forms',
    'routing_forms_guard',
    'routing_forms_last_version_number_check',
    (f: RoutingFixture) => ({ ...formValues(f), last_version_number: -1 }),
  ],
  [
    'positive version backstop',
    'routing_form_versions',
    'routing_form_versions_guard',
    'routing_form_versions_version_number_check',
    (f: RoutingFixture) => ({ ...versionValues(f), version_number: 0 }),
  ],
  [
    'unique version number backstop',
    'routing_form_versions',
    'routing_form_versions_guard',
    'routing_form_versions_form_id_version_number_key',
    versionValues,
  ],
] as const) {
  routingProtections[name] = {
    check: async (f) => {
      const client = await f.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
        await expect(insertRow(client, table, values(f))).rejects.toMatchObject({
          code: name.startsWith('unique') ? '23505' : '23514',
          constraint,
        })
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    },
    break: drop(table, constraint),
  }
}
routingProtections['version quota is not organization scoped'] = {
  check: async (f) => {
    const protection = routingProtections['retained version quota per form']
    if (!protection) throw new Error('Missing per-form quota protection')
    await protection.check(f)
  },
  break: (source) => source.replace('AND form_id = NEW.form_id) >= 1000', ') >= 1000'),
}
routingProtections['archived forms do not consume active quota'] = {
  check: async (f) => {
    const protection = routingProtections['non-archived form quota and archive frees capacity']
    if (!protection) throw new Error('Missing active quota protection')
    await protection.check(f)
  },
  break: (source) => source.replace('AND archived_at IS NULL) >= 100', ') >= 100'),
}

for (const booking of [false, true]) {
  routingProtections[
    booking
      ? 'booking share lock permits form admission'
      : 'concurrent share holders create forms without escalation'
  ] = {
    check: (f) => checkSharedOrganizationLocks(f, booking),
    break: (source) =>
      source.replace(
        "PERFORM pg_advisory_xact_lock(hashtextextended('hourmere.routing-form-quota:' || NEW.organization_id::text, 0));",
        'UPDATE auth.organization SET id = id WHERE id = NEW.organization_id;',
      ),
  }
}

routingProtections['stale snapshot form admission requires retry'] = {
  check: (f) => checkQuotaRace(f, 'forms', true),
  break: (source) =>
    source.replace("current_setting('transaction_isolation') <> 'read committed'", 'false'),
}
routingProtections['total form quota serialization'] = {
  check: (f) => checkQuotaRace(f, 'totalForms'),
  break: (source) =>
    source.replace(
      "PERFORM pg_advisory_xact_lock(hashtextextended('hourmere.routing-form-quota:' || NEW.organization_id::text, 0));",
      'PERFORM 1;',
    ),
}
routingProtections['unarchive obeys active form quota'] = {
  check: async (f) => {
    const max = readRoutingStorageLimits().forms_per_organization
    await f.pool.query(
      `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft) SELECT $1,'active-' || n,$2,'{}' FROM generate_series(2,$3::int) n`,
      [f.organization, f.creator, max],
    )
    const archived = await insertRow(f.pool, 'routing_forms', {
      ...formValues(f),
      archived_at: new Date(),
    })
    await expect(
      f.pool.query('UPDATE routing_forms SET archived_at=NULL WHERE id=$1', [archived]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'routing_forms_quota' })
    await f.pool.query('UPDATE routing_forms SET archived_at=now() WHERE id=$1', [f.form])
    await expect(
      f.pool.query('UPDATE routing_forms SET archived_at=NULL WHERE id=$1', [archived]),
    ).resolves.toMatchObject({ rowCount: 1 })
  },
  break: (source) =>
    source.replace(
      "IF TG_OP = 'INSERT' OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN",
      "IF TG_OP = 'INSERT' THEN",
    ),
}

/** Columns 0072 declares NOT NULL outside primary keys, with a row that is valid otherwise. */
const requiredColumns: [
  table: string,
  row: (f: RoutingFixture) => Record<string, unknown>,
  columns: string[],
][] = [
  [
    'routing_forms',
    (f) => ({
      ...formValues(f),
      draft_revision: 1,
      last_version_number: 0,
      enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    [
      'organization_id',
      'slug',
      'created_by_user_id',
      'draft',
      'draft_revision',
      'last_version_number',
      'enabled',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'routing_form_versions',
    (f) => ({ ...versionValues(f), version_number: 2, published_at: new Date() }),
    [
      'organization_id',
      'form_id',
      'version_number',
      'questions',
      'rules',
      'fallback',
      'published_at',
      'published_by_user_id',
    ],
  ],
  [
    'routing_target_dependencies',
    (f) => ({ ...dependencyValues(f), rule_id: randomUUID(), health_code: 'ok' }),
    ['organization_id', 'event_type_id', 'health_code'],
  ],
  [
    'routing_receipts',
    (f) => ({ ...receiptValues(f), created_at: new Date() }),
    [
      'organization_id',
      'form_id',
      'version_id',
      'token_hash',
      'matched_rule_id',
      'resolved_rule_id',
      'resolved_target',
      'created_at',
      'expires_at',
    ],
  ],
  [
    'booking_routing',
    bookingRoutingValues,
    [
      'organization_id',
      'form_id',
      'version_id',
      'version_number',
      'matched_rule_id',
      'resolved_rule_id',
      'questions',
      'answers',
    ],
  ],
]
routingProtections['required columns'] = {
  check: async (f) => {
    const client = await f.pool.connect()
    const outcomes: string[] = []
    try {
      await client.query('BEGIN')
      for (const [table, row, columns] of requiredColumns)
        for (const column of columns) {
          const values: Record<string, unknown> = { ...row(f), [column]: null }
          // The version guard rejects a missing number for an existing form before the NOT
          // NULL check runs; a form id without a form leaves only the column to reject it.
          if (table === 'routing_form_versions' && column === 'version_number')
            values.form_id = randomUUID()
          await client.query('SAVEPOINT probe')
          try {
            await insertRow(client, table, values)
            outcomes.push(`${table}.${column}: accepted`)
          } catch (error) {
            const { code, column: rejected } = error as { code?: string; column?: string }
            // Only integrity rejections are outcomes; anything else is a broken run.
            if (typeof code !== 'string' || !/^(23|22|P0)/.test(code)) throw error
            if (code !== '23502' || rejected !== column)
              outcomes.push(`${table}.${column}: ${code} ${rejected ?? ''}`.trim())
          }
          await client.query('ROLLBACK TO SAVEPOINT probe')
        }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(outcomes).toEqual([])
  },
  break: (source) => source.replace('  slug text NOT NULL', '  slug text'),
}

routingProtections['ids are unique across organizations'] = {
  check: async (f) => {
    const receipt = await insertRow(f.pool, 'routing_receipts', receiptValues(f))
    const other = {
      ...f,
      organization: f.otherOrganization,
      form: f.otherForm,
      version: f.otherVersion,
    }
    // The scoped keys include the organization, so only the primary key rejects these.
    for (const [table, values] of [
      ['routing_forms', { ...formValues(other), id: f.form }],
      ['routing_form_versions', { ...versionValues(other), version_number: 2, id: f.version }],
      ['routing_receipts', { ...receiptValues(other), id: receipt }],
    ] as const)
      await expect(insertRow(f.pool, table, values), table).rejects.toMatchObject({
        code: '23505',
        constraint: `${table}_pkey`,
      })
  },
  break: drop('routing_receipts', 'routing_receipts_pkey'),
}

routingProtections['form updates refresh updated_at'] = {
  check: async (f) => {
    const form = await insertRow(f.pool, 'routing_forms', {
      ...formValues(f),
      created_at: '2020-01-01T00:00Z',
      updated_at: '2020-01-01T00:00Z',
    })
    await expect(
      f.pool.query('UPDATE routing_forms SET draft_revision=2 WHERE id=$1', [form]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect(
      (
        await f.pool.query<{ refreshed: boolean }>(
          `SELECT updated_at > '2020-01-01T00:00Z' AS refreshed FROM routing_forms WHERE id=$1`,
          [form],
        )
      ).rows,
    ).toEqual([{ refreshed: true }])
  },
  break: noTrigger('routing_forms', 'routing_forms_updated_at'),
}

// The composite FKs already keep these rows in their parent's organization. The organization
// FK also makes the insert lock the organization row (FOR KEY SHARE), so an organization
// deletion that starts during the inserting transaction waits for it. Without that lock the
// deletion removes the organization row and waits in its cascade on the parent row, and the
// transaction's next write that checks the organization deadlocks with it (40P01).
const organizationLocks: [
  name: string,
  table: string,
  constraint: string,
  row: (f: RoutingFixture) => Record<string, unknown>,
][] = [
  [
    'version insert locks its organization',
    'routing_form_versions',
    'routing_form_versions_organization_id_fkey',
    (f) => ({ ...versionValues(f), version_number: 2 }),
  ],
  [
    'dependency insert locks its organization',
    'routing_target_dependencies',
    'routing_target_dependencies_organization_id_fkey',
    dependencyValues,
  ],
  [
    'snapshot insert locks its organization',
    'booking_routing',
    'booking_routing_organization_id_fkey',
    bookingRoutingValues,
  ],
]
for (const [name, table, constraint, row] of organizationLocks)
  routingProtections[name] = {
    check: async (f) => {
      const writer = await f.pool.connect()
      try {
        await writer.query('BEGIN')
        await insertRow(writer, table, row(f))
        // FOR UPDATE conflicts with FOR KEY SHARE, and SKIP LOCKED returns no row instead of
        // waiting, so a missing lock is a plain value mismatch.
        expect(
          (
            await f.pool.query(
              'SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE SKIP LOCKED',
              [f.organization],
            )
          ).rows,
          `${table} insert leaves its organization row unlocked`,
        ).toEqual([])
      } finally {
        await writer.query('ROLLBACK').catch(() => {})
        writer.release()
      }
    },
    break: drop(table, constraint),
  }

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Cond'?: string
  Plans?: PlanNode[]
}
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)]
/**
 * Lookups the storage must answer from an index: the organization, booking and version
 * cascades and retention checks, the dependency health sweep, receipt admission and expiry,
 * and the form list. `columns` must all appear in one index condition on `table`; an ordered
 * lookup must also come out of the index without a sort.
 */
const indexedLookups = (f: RoutingFixture) => [
  {
    lookup: 'form list page of an organization',
    table: 'routing_forms',
    columns: ['organization_id'],
    ordered: true,
    sql: 'SELECT id FROM routing_forms WHERE organization_id=$1 ORDER BY created_at,id LIMIT 50',
    params: [f.organization],
  },
  {
    lookup: 'dependencies on an event type',
    table: 'routing_target_dependencies',
    columns: ['organization_id', 'event_type_id'],
    sql: 'SELECT version_id,rule_id FROM routing_target_dependencies WHERE organization_id=$1 AND event_type_id=$2',
    params: [f.organization, f.event],
  },
  {
    lookup: 'unconsumed receipts by expiry, oldest first',
    table: 'routing_receipts',
    columns: ['expires_at'],
    ordered: true,
    sql: 'SELECT id FROM routing_receipts WHERE consumed_booking_id IS NULL AND expires_at<=$1 ORDER BY expires_at,id LIMIT 100',
    params: ['2030-01-01T00:00Z'],
  },
  {
    lookup: 'live receipts of a form at admission',
    table: 'routing_receipts',
    columns: ['organization_id', 'form_id', 'expires_at'],
    sql: 'SELECT count(*) FROM routing_receipts WHERE organization_id=$1 AND form_id=$2 AND consumed_booking_id IS NULL AND expires_at>$3',
    params: [f.organization, f.form, '2030-01-01T00:00Z'],
  },
  {
    lookup: 'receipts consumed by a booking',
    table: 'routing_receipts',
    columns: ['consumed_booking_id'],
    sql: 'SELECT id FROM routing_receipts WHERE consumed_booking_id=$1',
    params: [f.booking],
  },
  {
    lookup: 'receipts that retain a version',
    table: 'routing_receipts',
    columns: ['organization_id', 'form_id', 'version_id'],
    sql: 'SELECT 1 FROM routing_receipts WHERE organization_id=$1 AND form_id=$2 AND version_id=$3',
    params: [f.organization, f.form, f.version],
  },
  {
    lookup: 'snapshots of an organization',
    table: 'booking_routing',
    columns: ['organization_id'],
    sql: 'SELECT booking_id FROM booking_routing WHERE organization_id=$1',
    params: [f.organization],
  },
  {
    lookup: 'snapshots attributed to a version',
    table: 'booking_routing',
    columns: ['form_id', 'version_id'],
    sql: 'SELECT booking_id FROM booking_routing WHERE form_id=$1 AND version_id=$2',
    params: [f.form, f.version],
  },
]
routingProtections['indexed lookups'] = {
  check: async (f) => {
    const client = await f.pool.connect()
    const unindexed: string[] = []
    try {
      await client.query('BEGIN')
      // This relies on the coverage run's fresh, unanalysed copies: on their small tables,
      // with sequential and bitmap scans off, the planner answers each lookup from the index
      // whose condition matches it, so the plan shows whether that index exists. On a large
      // analysed table the planner may choose another index (the admission lookup can use
      // routing_receipts_version), which fails this check on the unmodified schema: the
      // coverage run aborts instead of reporting false coverage.
      await client.query('SET LOCAL enable_seqscan=off')
      await client.query('SET LOCAL enable_bitmapscan=off')
      for (const { lookup, table, columns, ordered, sql, params } of indexedLookups(f)) {
        const plan = (
          await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
            `EXPLAIN (FORMAT JSON) ${sql}`,
            params,
          )
        ).rows[0]?.['QUERY PLAN'][0].Plan as PlanNode
        const nodes = planNodes(plan)
        const indexed = nodes.some(
          (node) =>
            node['Relation Name'] === table &&
            columns.every((column) => new RegExp(`\\b${column}\\b`).test(node['Index Cond'] ?? '')),
        )
        const sorted = nodes.some((node) => node['Node Type'].endsWith('Sort'))
        if (!indexed || (ordered && sorted))
          unindexed.push(
            `${lookup}: ${nodes.map((node) => `${node['Node Type']} ${node['Index Cond'] ?? ''}`.trim()).join(' > ')}`,
          )
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(unindexed).toEqual([])
  },
  break: (source) =>
    source.replace(
      'CREATE INDEX routing_receipts_booking ON routing_receipts (consumed_booking_id);\n',
      '',
    ),
}

/** Behavioural checks that span several objects; the routing storage tests run each one. */
export const routingBehaviours: Record<string, (f: RoutingFixture) => Promise<void>> = {
  'publishes atomically with a deferred same-form pointer and preserves historical authors': async (
    f,
  ) => {
    const client = await f.pool.connect()
    const id = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query(
        'UPDATE routing_forms SET published_version_id=$1,enabled=true WHERE id=$2',
        [id, f.form],
      )
      await insertRow(client, 'routing_form_versions', {
        ...versionValues(f),
        id,
        version_number: 2,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await expect(
      f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.creator]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect(
      (
        await f.pool.query(
          'SELECT created_by_user_id,published_version_id,enabled FROM routing_forms WHERE id=$1',
          [f.form],
        )
      ).rows,
    ).toEqual([{ created_by_user_id: f.creator, published_version_id: id, enabled: true }])
    expect(
      (
        await f.pool.query('SELECT published_by_user_id FROM routing_form_versions WHERE id=$1', [
          id,
        ])
      ).rows,
    ).toEqual([{ published_by_user_id: f.creator }])
    await expect(
      f.pool.query('UPDATE routing_forms SET archived_at=now() WHERE id=$1', [f.form]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query('UPDATE routing_forms SET enabled=false,archived_at=now() WHERE id=$1', [
        f.form,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
  },
  'keeps snapshots through form cleanup and dependencies through event deletion': async (f) => {
    await insertRow(f.pool, 'routing_target_dependencies', dependencyValues(f))
    await insertRow(f.pool, 'booking_routing', bookingRoutingValues(f))
    await expect(
      f.pool.query('DELETE FROM event_types WHERE id=$1', [f.event]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect(
      (
        await f.pool.query(
          'SELECT event_type_id,health_code FROM routing_target_dependencies WHERE version_id=$1',
          [f.version],
        )
      ).rows,
    ).toEqual([{ event_type_id: f.event, health_code: 'unknown' }])
    await expect(
      f.pool.query('DELETE FROM routing_forms WHERE id=$1', [f.form]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect(
      (
        await f.pool.query('SELECT version_id FROM booking_routing WHERE booking_id=$1', [
          f.booking,
        ])
      ).rows,
    ).toEqual([{ version_id: f.version }])
    expect(
      (
        await f.pool.query('SELECT * FROM routing_target_dependencies WHERE version_id=$1', [
          f.version,
        ])
      ).rows,
    ).toEqual([])
    await expect(
      f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking]),
    ).resolves.toMatchObject({ rowCount: 1 })
    expect(
      (await f.pool.query('SELECT * FROM booking_routing WHERE booking_id=$1', [f.booking])).rows,
    ).toEqual([])
  },
  'organization deletion cascades all five tables even with current pointers and consumed evidence':
    async (f) => {
      await f.pool.query('UPDATE routing_forms SET published_version_id=$1 WHERE id=$2', [
        f.version,
        f.form,
      ])
      await insertRow(f.pool, 'routing_target_dependencies', dependencyValues(f))
      await insertRow(f.pool, 'booking_routing', bookingRoutingValues(f))
      await insertRow(f.pool, 'routing_receipts', receiptValues(f))
      await insertRow(f.pool, 'routing_receipts', {
        ...receiptValues(f),
        consumed_booking_id: f.booking,
        answers_ciphertext: null,
      })
      await expect(
        f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization]),
      ).resolves.toMatchObject({ rowCount: 1 })
      for (const table of [
        'routing_forms',
        'routing_form_versions',
        'routing_target_dependencies',
        'routing_receipts',
        'booking_routing',
      ])
        expect(
          (await f.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [f.organization]))
            .rows,
          table,
        ).toEqual([])
      expect(
        (await f.pool.query('SELECT id FROM routing_forms WHERE id=$1', [f.otherForm])).rows,
      ).toHaveLength(1)
    },
}

// Lock and race checks wait on other sessions, and the stale-snapshot check expects a
// serialization failure (40001), which a coverage run treats as a broken run; the routing
// storage tests run them. The last two only re-run another check.
const notInCoverage = new Set([
  'form quota serialization',
  'version quota serialization',
  'total form quota serialization',
  'stale snapshot form admission requires retry',
  'booking share lock permits form admission',
  'concurrent share holders create forms without escalation',
  'version quota is not organization scoped',
  'archived forms do not consume active quota',
])
// Checks that guard many objects run first, so a dropped object usually fails fast.
const firstInCoverage = ['required columns', 'indexed lookups']
// The backstops disable a guard trigger by name; without that trigger the statement would
// fail outright, so they run after the checks that fail when the trigger is missing.
const lastInCoverage = [
  'nonnegative high water backstop',
  'positive version backstop',
  'unique version number backstop',
]

/**
 * The protection suite for the 0072 constraint coverage run: every routing protection and
 * behaviour above, once each, on its own fixture. The error names the first failing check.
 */
export async function assertRoutingFormProtections(pool: pg.Pool): Promise<void> {
  const protection = (name: string) => {
    const found = routingProtections[name]
    if (!found) throw new Error(`Missing routing protection ${name}`)
    return found.check
  }
  const checks = new Map<(f: RoutingFixture) => Promise<void>, string>()
  const add = (name: string, check: (f: RoutingFixture) => Promise<void>) => {
    if (!checks.has(check)) checks.set(check, name)
  }
  for (const name of firstInCoverage) add(name, protection(name))
  for (const [name, { check }] of Object.entries(routingProtections))
    if (!notInCoverage.has(name) && !lastInCoverage.includes(name)) add(name, check)
  for (const [name, check] of Object.entries(routingBehaviours)) add(name, check)
  for (const name of lastInCoverage) add(name, protection(name))
  for (const [check, name] of checks) {
    try {
      await check(await routingFixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
