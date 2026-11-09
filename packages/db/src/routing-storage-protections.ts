import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  bookingRoutingValues,
  formValues,
  insertRow,
  quote,
  type RoutingFixture,
  receiptValues,
  versionValues,
} from './routing-storage-fixtures.ts'
import { checkQuotaRace } from './routing-storage-quota-races.ts'

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
  'form quota including archived forms': {
    check: async (f) => {
      await f.pool.query(
        `INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft,archived_at)
        SELECT $1,'quota-' || n,$2,'{}',now() FROM generate_series(2,100) n`,
        [f.organization, f.creator],
      )
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS count FROM routing_forms WHERE organization_id=$1',
            [f.organization],
          )
        ).rows,
      ).toEqual([{ count: 100 }])
      await expect(insertRow(f.pool, 'routing_forms', formValues(f))).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'routing_forms_quota',
      })
      await f.pool.query('DELETE FROM routing_forms WHERE organization_id=$1 AND slug=$2', [
        f.organization,
        'quota-100',
      ])
      await insertRow(f.pool, 'routing_forms', formValues(f))
    },
    break: (source) => source.replace('>= 100 THEN', '>= 101 THEN'),
  },
  'retained version quota': {
    check: async (f) => {
      await f.pool.query(
        `INSERT INTO routing_form_versions
        (organization_id,form_id,version_number,questions,rules,fallback,published_by_user_id)
        SELECT $1,$2,n,'[]','[]','{}',$3 FROM generate_series(2,1000) n`,
        [f.organization, f.form, f.creator],
      )
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS count FROM routing_form_versions WHERE form_id=$1',
            [f.form],
          )
        ).rows,
      ).toEqual([{ count: 1000 }])
      await expect(
        insertRow(f.pool, 'routing_form_versions', {
          ...versionValues(f),
          version_number: 1001,
        }),
      ).rejects.toMatchObject({ ...checkViolation, constraint: 'routing_form_versions_quota' })
      await f.pool.query(
        'DELETE FROM routing_form_versions WHERE form_id=$1 AND version_number=1000',
        [f.form],
      )
      await insertRow(f.pool, 'routing_form_versions', {
        ...versionValues(f),
        version_number: 1001,
      })
    },
    break: (source) => source.replace('>= 1000 THEN', '>= 1001 THEN'),
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
    'receipt digest format',
    'routing_receipts',
    'routing_receipts_token_hash_check',
    receiptValues,
    'token_hash',
    'raw-capability',
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
for (const table of ['routing_receipts', 'booking_routing'])
  for (const column of ['matched_rule_id', 'resolved_rule_id'])
    checks.push([
      `${table} ${column} identity`,
      table,
      `${table}_${column}_check`,
      table === 'routing_receipts' ? receiptValues : bookingRoutingValues,
      column,
      'rule-name',
    ])
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
routingProtections['dependency rule identity'] = {
  check: async (f) => {
    await expect(
      insertRow(f.pool, 'routing_target_dependencies', {
        organization_id: f.organization,
        version_id: f.version,
        rule_id: 'rule-name',
        event_type_id: f.event,
      }),
    ).rejects.toMatchObject(checkViolation)
  },
  break: drop('routing_target_dependencies', 'routing_target_dependencies_rule_id_check'),
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
      'UPDATE auth.organization SET id = id WHERE id = NEW.organization_id;',
      'PERFORM id FROM auth.organization WHERE id = NEW.organization_id;',
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
