import * as Crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as HourmereDb from '@hourmere/db'
import * as Kysely from 'kysely'
import { expect } from 'vitest'
import * as Zod from 'zod'
import * as Availability from './availability.ts'
import * as BookingPage from './booking-page.ts'
import * as Conferences from './conferences.ts'
import * as Errors from './errors.ts'
import * as GroupSeatAdmission from './group-seat-admission.ts'
import * as Hosts from './hosts.ts'
import * as LocationOptions from './location-options.ts'
import * as NotificationSettings from './notification-settings.ts'
import * as OneTimeLinks from './one-time-links.ts'
import * as PaymentExpiry from './payment-expiry.ts'
import * as Questions from './questions.ts'
import * as RoundRobin from './round-robin.ts'
import * as SuccessRedirect from './success-redirect.ts'
import * as Text from './text.ts'
import * as Waitlist from './waitlist.ts'
import * as WaitlistBooking from './waitlist-booking.ts'

export type BookingModule = Pick<
  typeof import('./bookings.ts'),
  | 'getHostBooking'
  | 'requestReschedule'
  | 'expireRescheduleRequest'
  | 'cancelManagedBooking'
  | 'rescheduleManagedBooking'
>
export type Change = readonly [string, string]
const dependencies: Record<string, object> = {
  'node:crypto': Crypto,
  kysely: Kysely,
  zod: Zod,
  '@hourmere/db': HourmereDb,
  './availability.ts': Availability,
  './booking-page.ts': BookingPage,
  './conferences.ts': Conferences,
  './errors.ts': Errors,
  './hosts.ts': Hosts,
  './location-options.ts': LocationOptions,
  './group-seat-admission.ts': GroupSeatAdmission,
  './notification-settings.ts': NotificationSettings,
  './one-time-links.ts': OneTimeLinks,
  './payment-expiry.ts': PaymentExpiry,
  './questions.ts': Questions,
  './round-robin.ts': RoundRobin,
  './success-redirect.ts': SuccessRedirect,
  './text.ts': Text,
  './waitlist.ts': Waitlist,
  './waitlist-booking.ts': WaitlistBooking,
}

/** Only an in-memory source copy changes; dependencies remain the real service modules. */
export function sourceCopy(change?: Change, findSlots = Availability.findSlots): BookingModule {
  let source = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replaceAll(...change)
  }
  source = stripTypeScriptTypes(source).replace(/^export \{[^}]*\} from '[^']+'\n/gm, '')
  const bindings: Record<string, unknown> = {}
  source = source.replace(
    /^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm,
    (_, specifiers: string, specifier: string) => {
      const module = dependencies[specifier] as Record<string, unknown> | undefined
      if (!module) throw new Error(`Missing source-copy dependency: ${specifier}`)
      for (const item of specifiers.split(',')) {
        const [name, alias] = item.trim().split(/\s+as\s+/)
        if (!name) continue
        if (!(name in module)) throw new Error(`Missing source-copy binding: ${name}`)
        bindings[alias ?? name] = name === 'findSlots' ? findSlots : module[name]
      }
      return ''
    },
  )
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return { getHostBooking, requestReschedule, expireRescheduleRequest, cancelManagedBooking, rescheduleManagedBooking }`,
  )(...Object.values(bindings)) as BookingModule
}
