import { expect } from 'vitest'
import {
  type GroupFixture,
  insertRecord,
  insertSeat,
  insertSlot,
  occupiedSlot,
  transaction,
} from './group-seats-fixtures.ts'
import { assertGroupModeFence } from './group-seats-mode-fence.ts'
import { groupProtections } from './group-seats-protections.ts'
import { receiptProtections } from './group-seats-receipts.ts'

const replace = (source: string, from: string, to: string) => {
  expect(source).toContain(from)
  return source.replace(from, to)
}
const withoutCount = (source: string) =>
  replace(
    source,
    "IF actual<>slot.active_seats OR (slot.state='open')<>(actual>0) THEN",
    'IF false THEN',
  )
const withoutHost = (source: string) =>
  replace(
    source,
    `IF slot.state='open' AND EXISTS (SELECT FROM auth."user" WHERE id=slot.host_user_id)`,
    `IF false AND EXISTS (SELECT FROM auth."user" WHERE id=slot.host_user_id)`,
  )
const withoutBooker = (source: string) =>
  replace(
    source,
    'IF EXISTS (SELECT FROM bookings b WHERE b.group_slot_id=target AND (',
    'IF false AND EXISTS (SELECT FROM bookings b WHERE b.group_slot_id=target AND (',
  )

export interface Protection {
  check: (f: GroupFixture) => Promise<void>
  break: (source: string) => string
}
const protection = (name: string) => groupProtections[name] as Protection['check']
const receipt = (name: string) => receiptProtections[name] as Protection['check']

export const groupSourceProtections: Record<string, Protection> = {
  'ordinary booking admission fences event mode conversion': {
    check: assertGroupModeFence,
    break: (s) =>
      replace(
        s,
        `        PERFORM pg_advisory_xact_lock_shared(hashtextextended(
          'event-booking-mode:' || NEW.event_type_id::text,0));`,
        '',
      ),
  },

  'unchanged host overlap exclusion': {
    check: protection('derived occupancy'),
    break: (s) => `${s}\nALTER TABLE booking_hosts DROP CONSTRAINT booking_hosts_no_overlap;`,
  },
  'configuration scalar checks': {
    check: protection('configuration'),
    break: (s) =>
      `${s}\nALTER TABLE event_types DROP CONSTRAINT event_types_booking_mode,DROP CONSTRAINT event_types_group_capacity;`,
  },
  'ECMAScript normalized mailboxes': {
    check: async (f) => {
      for (const character of '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
        expect(
          (
            await f.pool.query('SELECT normalize_group_booker_key($1) AS value', [
              `${character}Mixed@Example.Test${character}`,
            ])
          ).rows,
        ).toEqual([{ value: 'mixed@example.test' }])
    },
    break: (s) =>
      s.replace(/SELECT lower\(btrim\(mailbox,[\s\S]*?\)\);/, 'SELECT lower(btrim(mailbox));'),
  },
  'occupancy XOR parents': {
    check: protection('parent XOR'),
    break: (s) =>
      `${replace(
        s,
        'DECLARE parent_host uuid; seat_slot uuid;\nBEGIN',
        `DECLARE parent_host uuid; seat_slot uuid;
BEGIN
  IF (NEW.booking_id IS NULL)=(NEW.group_slot_id IS NULL) THEN
    NEW.period := tstzrange('2040-01-01','2040-01-02'); NEW.active := false; RETURN NEW;
  END IF;`,
      )}\nALTER TABLE booking_hosts DROP CONSTRAINT booking_hosts_parent;`,
  },
  'parent-derived period and active': {
    check: protection('derived occupancy'),
    break: (s) =>
      withoutHost(
        replace(
          s,
          'DECLARE parent_host uuid; seat_slot uuid;\nBEGIN',
          `DECLARE parent_host uuid; seat_slot uuid;
BEGIN
  IF NEW.group_slot_id IS NOT NULL AND TG_OP='UPDATE' THEN RETURN NEW; END IF;`,
        ),
      ),
  },
  'pinned host occupancy': {
    check: protection('pinned host'),
    break: (s) => withoutHost(replace(s, 'IF NEW.user_id<>parent_host THEN', 'IF false THEN')),
  },
  'seats never own exclusion rows': {
    check: protection('seat cannot own occupancy'),
    break: (s) => replace(s, 'IF seat_slot IS NOT NULL THEN', 'IF false THEN'),
  },
  'exact seat interval': {
    check: async (f) => {
      const { slot } = await occupiedSlot(f)
      await expect(
        transaction(f.pool, (sql) =>
          insertSeat(sql, f, slot, undefined, { end_at: '2032-01-02T11:00Z' }),
        ),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      withoutBooker(
        s.replace(
          /IF NEW.organization_id<>slot.organization_id[\s\S]*?THEN\n {4}-- During physical/,
          'IF false THEN\n    -- During physical',
        ),
      ),
  },
  'immutable slot snapshot': {
    check: async (f) => {
      const { slot } = await occupiedSlot(f)
      await expect(
        f.pool.query(`UPDATE group_slots SET title='Changed snapshot' WHERE id=$1`, [slot]),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      replace(
        s,
        'IF ROW(NEW.id,NEW.organization_id,NEW.original_event_type_id,NEW.host_user_id,',
        'IF false AND ROW(NEW.id,NEW.organization_id,NEW.original_event_type_id,NEW.host_user_id,',
      ),
  },
  'immutable seat mailbox binding': {
    check: async (f) => {
      const { bookings } = await occupiedSlot(f)
      await expect(
        transaction(f.pool, async (sql) => {
          await sql.query(
            `UPDATE bookings SET group_booker_key='changed@example.test' WHERE id=$1`,
            [bookings[0]],
          )
          await sql.query(
            `UPDATE booking_attendees SET email='changed@example.test' WHERE booking_id=$1`,
            [bookings[0]],
          )
        }),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      replace(
        s,
        'IF ROW(NEW.id,NEW.organization_id,NEW.group_slot_id,NEW.group_booker_key,NEW.start_at,NEW.end_at)',
        'IF false AND ROW(NEW.id,NEW.organization_id,NEW.group_slot_id,NEW.group_booker_key,NEW.start_at,NEW.end_at)',
      ),
  },
  'capacity conditional increment and bounds': {
    check: protection('capacity'),
    break: (s) =>
      replace(
        replace(s, 'CHECK (active_seats BETWEEN 0 AND capacity)', 'CHECK (active_seats>=0)'),
        "WHERE id=slot.id AND state='open' AND active_seats<capacity;",
        "WHERE id=slot.id AND state='open';",
      ),
  },
  'caller-owned counter and revision edits': {
    check: async (f) => {
      const { slot } = await occupiedSlot(f)
      await expect(
        f.pool.query('UPDATE group_slots SET revision=revision+1 WHERE id=$1', [slot]),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      s.replace(
        /IF \(NEW.active_seats IS DISTINCT FROM OLD.active_seats AND pg_trigger_depth\(\)<>2\)[\s\S]*?THEN/,
        'IF false THEN',
      ),
  },
  'deferred exact count rejects nested counter drift': {
    check: async (f) => {
      const { slot } = await occupiedSlot(f)
      // A nested writer reaches pg_trigger_depth=2, like legitimate seat accounting.
      // The deferred exact COUNT must still reject it; no user session bypass flag.
      await f.pool.query(`CREATE TABLE test_nested_slot_counter(slot_id uuid);
        CREATE FUNCTION test_nested_slot_counter_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE group_slots SET active_seats=active_seats+1 WHERE id=NEW.slot_id; RETURN NEW; END $$;
        CREATE TRIGGER test_nested_slot_counter_trigger AFTER INSERT ON test_nested_slot_counter
          FOR EACH ROW EXECUTE FUNCTION test_nested_slot_counter_write();`)
      await expect(
        f.pool.query('INSERT INTO test_nested_slot_counter VALUES ($1)', [slot]),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: withoutCount,
  },
  'normalized single matching booker': {
    check: protection('booker shape'),
    break: (s) =>
      `${withoutBooker(s)}\nALTER TABLE bookings DROP CONSTRAINT bookings_group_booker_shape;`,
  },
  'group seats forbid guests': { check: protection('no guests'), break: withoutBooker },
  'active mailbox uniqueness': {
    check: protection('mailbox uniqueness'),
    break: (s) => `${s}\nDROP INDEX bookings_group_active_mailbox;`,
  },
  'surviving required host occupancy': {
    check: protection('surviving occupancy'),
    break: withoutHost,
  },
  'open slots cannot commit empty': {
    check: async (f) => {
      await expect(
        transaction(f.pool, async (sql) => {
          const slot = await insertSlot(sql, f)
          await sql.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
            slot,
            f.host,
          ])
        }),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      replace(
        s,
        "IF actual<>slot.active_seats OR (slot.state='open')<>(actual>0) THEN",
        'IF actual<>slot.active_seats THEN',
      ),
  },
  'confirmed seat deletion protection': {
    check: protection('confirmed seat deletion'),
    break: (s) =>
      withoutCount(
        replace(
          s,
          "IF OLD.group_slot_id IS NOT NULL AND OLD.status='confirmed'",
          "IF false AND OLD.group_slot_id IS NOT NULL AND OLD.status='confirmed'",
        ),
      ),
  },
  'terminal generations never reactivate': {
    check: async (f) => {
      const { slot, bookings } = await occupiedSlot(f)
      await f.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
        [bookings[0]],
      )
      await expect(
        transaction(f.pool, async (sql) => {
          await sql.query(`UPDATE group_slots SET state='open' WHERE id=$1`, [slot])
          await insertSeat(sql, f, slot)
        }),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) => replace(s, "IF OLD.state<>'open' AND NEW.state<>OLD.state THEN", 'IF false THEN'),
  },
  'host cancellation tombstone': {
    check: async (f) => {
      const { slot, bookings } = await occupiedSlot(f)
      await transaction(f.pool, async (sql) => {
        await sql.query(`UPDATE group_slots SET state='host_cancelled' WHERE id=$1`, [slot])
        await sql.query(
          `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
          [bookings[0]],
        )
      })
      await expect(occupiedSlot(f)).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      replace(
        replace(
          s,
          'IF EXISTS (SELECT FROM group_slots WHERE original_event_type_id=NEW.original_event_type_id',
          'IF false AND EXISTS (SELECT FROM group_slots WHERE original_event_type_id=NEW.original_event_type_id',
        ),
        'IF EXISTS (SELECT FROM group_slots s WHERE s.id<>slot.id',
        'IF false AND EXISTS (SELECT FROM group_slots s WHERE s.id<>slot.id',
      ),
  },
  'mode changes reject booked future work': {
    check: async (f) => {
      await occupiedSlot(f)
      await expect(
        f.pool.query(
          `UPDATE event_types SET booking_mode='individual',group_capacity=NULL WHERE id=$1`,
          [f.event],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) => `${s}\nDROP TRIGGER event_types_booking_mode_guard ON event_types;`,
  },
  'slot history is retained after last cancellation': {
    check: async (f) => {
      const { slot, bookings } = await occupiedSlot(f)
      await f.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
        [bookings[0]],
      )
      await f.pool.query('DELETE FROM bookings WHERE id=$1', [bookings[0]])
      await expect(
        f.pool.query('DELETE FROM group_slots WHERE id=$1', [slot]),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) =>
      replace(
        s,
        'IF EXISTS (SELECT FROM auth.organization WHERE id=OLD.organization_id) THEN',
        'IF false THEN',
      ),
  },
  'capacity changes append waitlist wakeups': {
    check: async (f) => {
      await f.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [f.event])
      await f.pool.query(
        `INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,
        window_start,window_end,time_zone,locale,consent_version,consented_at,expires_at,pending_expires_at,
        status,verified_at)
        VALUES ($1,$2,decode(repeat('22',32),'hex'),'waiting@example.test',now()+interval '1 day',
          now()+interval '5 days','UTC','en','1',now(),now()+interval '5 days',now()+interval '24 hours','active',now())`,
        [f.organization, f.event],
      )
      const { slot } = await occupiedSlot(f)
      await f.pool.query('DELETE FROM waitlist_scan_signals WHERE event_type_id=$1', [f.event])
      await transaction(f.pool, (sql) => insertSeat(sql, f, slot))
      expect(
        (
          await f.pool.query('SELECT id FROM waitlist_scan_signals WHERE event_type_id=$1', [
            f.event,
          ])
        ).rows.length,
      ).toBeGreaterThan(0)
    },
    break: (s) => `${s}\nDROP TRIGGER group_slots_waitlist_signal ON group_slots;`,
  },
  'receipt scalar guards': {
    check: receipt('receipt scalar guards'),
    break: (s) => {
      const first = s.indexOf('CREATE TABLE group_booking_move_receipts')
      const end = s.indexOf('CREATE FUNCTION guard_group_receipt')
      const body = s.slice(first, end)
      return s.slice(0, first) + body.replace(/CHECK \([^\n]*\)/g, 'CHECK (true)') + s.slice(end)
    },
  },
  'receipt scope uniqueness': {
    check: receipt('receipt scope uniqueness'),
    break: (s) =>
      s.replaceAll(
        'UNIQUE (organization_id,authority_kind,authority_hash,request_key)',
        'CHECK (true)',
      ),
  },
  'receipt binding': {
    check: receipt('receipt binding'),
    break: (s) => {
      const first = s.indexOf('CREATE TABLE group_booking_move_receipts')
      const end = s.indexOf('CREATE FUNCTION guard_group_receipt')
      const body = s.slice(first, end).replace(/ {2}FOREIGN KEY[^\n]+\n/g, '')
      return `${s.slice(0, first)}${body}${s.slice(end)}\nDROP TRIGGER group_move_receipts_binding ON group_booking_move_receipts; DROP TRIGGER group_cancel_receipts_binding ON group_slot_cancel_receipts;`
    },
  },
  'attribution binding': {
    check: receipt('attribution binding'),
    break: (s) =>
      `${s}\nDROP TRIGGER organization_operations_group_binding ON organization_operations; ALTER TABLE organization_operations DROP CONSTRAINT organization_operations_group_slot_fkey;`,
  },
  'ordinary booking UPDATE cannot acquire an unbound group event': {
    check: async (f) => {
      const booking = await insertRecord(f.pool, 'bookings', {
        organization_id: f.organization,
        start_at: f.start,
        end_at: f.end,
        title: 'Ordinary',
        source: 'web',
      })
      await expect(
        f.pool.query('UPDATE bookings SET event_type_id=$1 WHERE id=$2', [f.event, booking]),
      ).rejects.toMatchObject({ code: '23514' })
    },
    break: (s) => replace(s, "IF mode='group' THEN", 'IF false THEN'),
  },
  'immutable receipts': {
    check: receipt('immutable receipts'),
    break: (s) =>
      `${s}\nDROP TRIGGER group_move_receipts_immutable ON group_booking_move_receipts; DROP TRIGGER group_cancel_receipts_immutable ON group_slot_cancel_receipts;`,
  },
}
