import { createHash, randomUUID } from 'node:crypto'
import type { CalendarConnections } from '@hourmere/db'
import type { Insertable } from 'kysely'
import { z } from 'zod'
import { redactCalDavField } from './caldav-redaction.ts'
import { decryptCredential, encryptCredential } from './credentials.ts'

/** Server-only input. Never include this object in logs or public responses. */
export interface CalDavCredentials {
  serverUrl: string
  username: string
  password: string
}

export type CalDavCredentialRecord = Pick<
  CalendarConnections,
  'user_id' | 'provider' | 'external_account_id' | 'credentials'
> & { id: string }

const noControls = (value: string) =>
  value.isWellFormed() &&
  [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && (code < 127 || code > 159)
  })

const payload = z.object({
  version: z.literal(1),
  serverUrl: z.string().min(1).max(8192),
  username: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => noControls(value) && !value.includes(':')),
  password: z.string().min(1).max(8192).refine(noControls),
})

function canonicalServerUrl(value: string): string {
  if (!noControls(value) || /\s|\\/.test(value)) throw new Error()
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error()
  }
  return url.href
}

function identity(serverUrl: string, username: string): string {
  return createHash('sha256')
    .update(JSON.stringify([serverUrl, username]))
    .digest('hex')
}

function aad(record: Omit<CalDavCredentialRecord, 'credentials'>): string {
  return JSON.stringify(['caldav', 1, record.user_id, record.id, record.external_account_id])
}

/**
 * Produces an insertable record for the existing calendar_connections table. It does
 * not connect or persist: callers must complete guarded discovery and owner/session
 * authorization first. URL validation here is structural, not an SSRF check.
 */
export function createCalDavCredentialRecord(
  key: Buffer,
  userId: string,
  input: CalDavCredentials,
): Insertable<CalendarConnections> & CalDavCredentialRecord {
  try {
    if (!userId) throw new Error()
    const parsed = payload.safeParse({ ...input, version: 1 })
    if (!parsed.success) throw new Error()
    const value = { ...parsed.data, serverUrl: canonicalServerUrl(parsed.data.serverUrl) }
    const record = {
      id: randomUUID(),
      user_id: userId,
      provider: 'caldav',
      external_account_id: identity(value.serverUrl, value.username),
    }
    return {
      ...record,
      credentials: encryptCredential(key, aad(record), JSON.stringify(value)),
      account_email: null,
      scopes: [],
      status: 'active',
      last_error: null,
    }
  } catch {
    // Do not retain validation issues, crypto errors or submitted secrets as causes.
    throw new Error('CalDAV credentials could not be encrypted')
  }
}

/** Internal transport use only; never return decrypted credentials from a service/API. */
export function readCalDavCredentials(
  key: Buffer,
  record: CalDavCredentialRecord,
): CalDavCredentials {
  try {
    if (record.provider !== 'caldav') throw new Error()
    const parsed = payload.safeParse(
      JSON.parse(decryptCredential(key, aad(record), record.credentials)),
    )
    if (!parsed.success) throw new Error()
    const { serverUrl, username, password } = parsed.data
    if (
      canonicalServerUrl(serverUrl) !== serverUrl ||
      identity(serverUrl, username) !== record.external_account_id
    ) {
      throw new Error()
    }
    return redactCalDavField({ serverUrl, username, password }, 'password')
  } catch {
    throw new Error('CalDAV credentials could not be decrypted')
  }
}
