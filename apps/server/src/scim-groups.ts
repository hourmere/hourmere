import { randomUUID } from 'node:crypto'
import { teamMembershipLimit } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { ScimReply, ScimResourceHandler, ScimResourceRequest } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import {
  parseScimListQuery,
  parseScimProjection,
  projectScimResource,
  scimGroupQuery,
  scimListResponse,
  scimPageWindow,
} from './scim-query.ts'
import { lockMappingTeams } from './scim-team-mapping-retirement.ts'
import {
  invalidSyntax,
  invalidValue,
  lockScimTokenConnection,
  onlyScimAttributes,
  refuse,
  scimAttributes,
  scimText,
  scimWriteRefusal,
} from './scim-user-write.ts'
import { scimUserNotFound as notFound, SCIM_USER_ID as RESOURCE_ID } from './scim-users.ts'

type Principal = ScimResourceRequest['principal']
const groupLocation = (base: string, id: string) => `${base}/Groups/${id}`
const userLocation = (base: string, id: string) => `${base}/Users/${id}`
const unavailable = () =>
  refuse(409, 'No available Group reservation matches this externalId.', 'uniqueness')
const invalidMember = () =>
  invalidValue('Each Group member must name an active, linked User of this connection.')

// The binding scopes both reservations and activated Groups to the authenticated parent.
function authorizedMappings(db: Db, { tokenId, organizationId }: Principal) {
  return db
    .selectFrom('scim_team_mappings as mapping')
    .where('mapping.live_parent_organization_id', '=', organizationId)
    .where('mapping.suspended_at', 'is', null)
    .where('mapping.live_connection_id', '=', (eb) =>
      eb
        .selectFrom('scim_token_connections')
        .select('connection_id')
        .where('token_id', '=', tokenId)
        .where('organization_id', '=', organizationId),
    )
}

function visibleGroups(db: Db, principal: Principal) {
  return authorizedMappings(db, principal)
    .innerJoin('scim_groups as scim_group', 'scim_group.mapping_id', 'mapping.id')
    .innerJoin('auth.organization as child', 'child.id', 'mapping.live_child_organization_id')
}

type VisibleGroups = ReturnType<typeof visibleGroups>
function selectGroups(query: VisibleGroups) {
  return query
    .select([
      'scim_group.id',
      'scim_group.created_at',
      'scim_group.updated_at',
      'mapping.external_id',
      'child.name',
    ])
    .select((eb) => {
      // Start with this mapping's provenance. Its composite FK requires the child
      // membership to exist, and only a live User from this parent connection is exposed.
      const roster = eb
        .selectFrom('scim_team_managed_memberships as source')
        .innerJoin('scim_users as directory_user', (join) =>
          join
            .onRef('directory_user.id', '=', 'source.scim_user_id')
            .onRef('directory_user.linked_user_id', '=', 'source.user_id'),
        )
        .whereRef('source.mapping_id', '=', 'mapping.id')
        .whereRef('source.child_organization_id', '=', 'child.id')
        .whereRef('directory_user.organization_id', '=', 'mapping.parent_organization_id')
        .whereRef('directory_user.connection_id', '=', 'mapping.connection_id')
        .where('directory_user.retired_at', 'is', null)
        .select('directory_user.id')
        .orderBy('directory_user.id')
      return sql<string[]>`array(${roster})`.as('member_ids')
    })
}

type Row = Awaited<ReturnType<ReturnType<typeof selectGroups>['execute']>>[number]
function representation(row: Row, base: string) {
  return {
    schemas: [SCIM_URN.group],
    id: row.id,
    externalId: row.external_id,
    displayName: row.name,
    ...(row.member_ids.length && {
      members: row.member_ids.map((id) => ({
        value: id,
        $ref: userLocation(base, id),
        type: 'User',
      })),
    }),
    meta: {
      resourceType: 'Group',
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: groupLocation(base, row.id),
    },
  }
}

async function listGroups(db: Db, request: ScimResourceRequest): Promise<ScimReply> {
  const parsed = parseScimListQuery(request.query, scimGroupQuery)
  if (!parsed.ok) return parsed.reply
  const { filter, projection, ...page } = parsed.value
  const window = scimPageWindow(page)
  const { total, rows } = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      let selected = visibleGroups(trx, request.principal)
      if (filter)
        selected =
          filter.attribute === 'externalId'
            ? selected.where('mapping.external_id', '=', filter.value)
            : selected.where(sql<boolean>`lower(child.name) = lower(${filter.value})`)
      const counted = await selected
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow()
      const rows = await selectGroups(selected)
        .orderBy('scim_group.id')
        .offset(window.offset)
        .limit(window.limit)
        .execute()
      return { total: Number(counted.total), rows }
    })
  const resources = rows.map((row) =>
    projectScimResource(scimGroupQuery, representation(row, request.base), projection),
  )
  return { status: 200, body: scimListResponse(page, total, resources) }
}

function scopedGroup(db: Db, principal: Principal, id: string) {
  return selectGroups(visibleGroups(db, principal))
    .where('scim_group.id', '=', id)
    .executeTakeFirst()
}

async function readGroup(db: Db, request: ScimResourceRequest, id: string): Promise<ScimReply> {
  if (!RESOURCE_ID.test(id)) return notFound
  const row = await scopedGroup(db, request.principal, id)
  if (!row) return notFound
  const parsed = parseScimProjection(request.query, scimGroupQuery)
  if (!parsed.ok) return parsed.reply
  return {
    status: 200,
    body: projectScimResource(scimGroupQuery, representation(row, request.base), parsed.value),
  }
}

function parseMembers(value: unknown, base: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > teamMembershipLimit)
    throw invalidValue('The members attribute is not a valid value.')
  const ids = value.map((item) => {
    const member = scimAttributes(item, 'members')
    onlyScimAttributes(member, ['value', '$ref', 'type', 'display', 'primary', 'role', 'roles'])
    if (member.get('role') !== undefined || member.get('roles') !== undefined)
      throw refuse(403, 'Group membership cannot assign a team role.', 'mutability')
    const type = member.get('type')
    if (type !== undefined && (typeof type !== 'string' || type.toLowerCase() !== 'user'))
      throw invalidMember()
    const id = member.get('value')
    if (typeof id !== 'string' || !RESOURCE_ID.test(id)) throw invalidMember()
    const ref = member.get('$ref')
    if (ref !== undefined && ref !== userLocation(base, id) && ref !== `/Users/${id}`)
      throw invalidMember()
    return id
  })
  return [...new Set(ids)]
}

function parseGroup(body: unknown, base: string) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalidSyntax('The request body must be a Group object.')
  const group = scimAttributes(body, 'Group')
  const schemas = group.get('schemas')
  if (
    !Array.isArray(schemas) ||
    schemas.length === 0 ||
    !schemas.every(
      (schema) =>
        typeof schema === 'string' && schema.toLowerCase() === SCIM_URN.group.toLowerCase(),
    )
  )
    throw invalidSyntax('The schemas attribute must name only the Group schema.')
  onlyScimAttributes(group, ['schemas', 'id', 'meta', 'externalid', 'displayname', 'members'])
  const name = group.get('displayname')
  const displayName = typeof name === 'string' ? name.trim() : ''
  if (
    !displayName ||
    displayName.length > 200 ||
    !displayName.isWellFormed() ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(displayName)
  )
    throw invalidValue('The displayName must be a single line of text up to 200 characters.')
  const externalId = scimText(group.get('externalid'), 'externalId', 256)
  if (!externalId) throw invalidValue('The externalId attribute is required.')
  return { externalId, displayName, members: parseMembers(group.get('members'), base) }
}

function availableMapping(db: Db, principal: Principal, externalId: string) {
  return authorizedMappings(db, principal)
    .where('mapping.external_id', '=', externalId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('scim_groups')
            .select('id')
            .whereRef('scim_groups.mapping_id', '=', 'mapping.id'),
        ),
      ),
    )
    .select(['mapping.id', 'mapping.child_organization_id', 'mapping.connection_id'])
}

async function linkedUsers(db: Db, organizationId: string, connectionId: string, ids: string[]) {
  if (ids.length === 0) return []
  const rows = await db
    .selectFrom('scim_users')
    .select(['id', 'linked_user_id'])
    .where('organization_id', '=', organizationId)
    .where('connection_id', '=', connectionId)
    .where('id', 'in', ids)
    .where('retired_at', 'is', null)
    .where('active', '=', true)
    .where('linked_user_id', 'is not', null)
    .orderBy('id')
    .$narrowType<{ linked_user_id: string }>()
    .execute()
  if (rows.length !== ids.length) throw invalidMember()
  return rows
}

async function insertRoster(
  trx: Db,
  mappingId: string,
  childId: string,
  users: Awaited<ReturnType<typeof linkedUsers>>,
) {
  if (users.length === 0) return
  const userIds = users.map((user) => user.linked_user_id)
  const members = trx.selectFrom('auth.member').where('organizationId', '=', childId)
  if (await members.select('id').where('userId', 'in', userIds).executeTakeFirst())
    throw refuse(409, 'A supplied User already belongs to the mapped team.')
  const { total } = await members
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow()
  if (Number(total) + userIds.length > teamMembershipLimit)
    throw refuse(409, 'The mapped team does not have room for these members.')

  const blocked = await trx
    .selectFrom('scim_membership_blocks as block')
    .select('block.id')
    .where('block.organization_id', '=', childId)
    .where('block.cleared_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('block.user_id', 'in', userIds),
        eb(
          'block.identity_email',
          'in',
          eb
            .selectFrom('auth.user')
            .select(sql<string>`lower(btrim(email))`.as('mailbox'))
            .where('id', 'in', userIds)
            .where('emailVerified', '=', true),
        ),
      ]),
    )
    .executeTakeFirst()
  if (blocked) throw refuse(403, 'A supplied User cannot be admitted to the mapped team.')

  const sourced = users.map((user) => ({
    member_id: randomUUID(),
    mapping_id: mappingId,
    child_organization_id: childId,
    user_id: user.linked_user_id,
    scim_user_id: user.id,
  }))
  await trx
    .insertInto('auth.member')
    .values(
      sourced.map((source) => ({
        id: source.member_id,
        userId: source.user_id,
        organizationId: childId,
        role: 'member',
        createdAt: sql<Date>`statement_timestamp()`,
      })),
    )
    .execute()
  await trx.insertInto('scim_team_managed_memberships').values(sourced).execute()
}

async function createGroup(db: Db, request: ScimResourceRequest): Promise<ScimReply> {
  const projection = parseScimProjection(request.query, scimGroupQuery)
  if (!projection.ok) return projection.reply
  const body = await request.body?.()
  if (!body) return invalidSyntax('The request body must be a Group object.').reply
  if (!body.ok) return body.reply
  const { principal } = request
  const { organizationId } = principal
  try {
    const { externalId, displayName, members } = parseGroup(body.value, request.base)
    const row = await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const available = availableMapping(trx, principal, externalId)
        const candidate = await available.executeTakeFirst()
        if (!candidate) throw unavailable()
        const childId = candidate.child_organization_id
        const proposed = await linkedUsers(trx, organizationId, candidate.connection_id, members)
        const accounts = proposed.map((user) => user.linked_user_id)
        if (accounts.length > 0) {
          // Keep the account and its verified mailbox stable. Native membership writes
          // also take their actor identity lock before the organization locks.
          const locked = await trx
            .selectFrom('auth.user')
            .select('id')
            .where('id', 'in', accounts)
            .orderBy('id')
            .forShare()
            .execute()
          if (locked.length !== accounts.length) throw invalidMember()
        }
        const teams = await lockMappingTeams(trx, [organizationId, childId])
        if (teams.length !== 2) throw unavailable()
        const connectionId = await lockScimTokenConnection(trx, principal)
        const mapping = await available
          .where('mapping.id', '=', candidate.id)
          .where('mapping.connection_id', '=', connectionId)
          .forUpdate('mapping')
          .executeTakeFirst()
        if (!mapping) throw unavailable()
        const current = await linkedUsers(trx, organizationId, connectionId, members)
        if (current.some((user, index) => user.linked_user_id !== accounts[index]))
          throw invalidMember()

        await trx
          .updateTable('auth.organization')
          .set({ name: displayName })
          .where('id', '=', childId)
          .execute()
        const { id } = await trx
          .insertInto('scim_groups')
          .values({ mapping_id: mapping.id })
          .returning('id')
          .executeTakeFirstOrThrow()
        await insertRoster(trx, mapping.id, childId, current)
        await writeAuditEvent(trx, {
          organizationId,
          actor: { type: 'scim_token', id: principal.tokenId },
          credential: { type: 'none' },
          action: 'scim_group.created',
          targetType: 'scim_group',
          targetId: id,
        })
        const created = await scopedGroup(trx, principal, id)
        if (!created) throw new Error('The created Group is not readable.')
        return created
      })
    return {
      status: 201,
      body: projectScimResource(
        scimGroupQuery,
        representation(row, request.base),
        projection.value,
      ),
      headers: { Location: groupLocation(request.base, row.id) },
    }
  } catch (error) {
    const reply = scimWriteRefusal(error)
    if (reply) return reply
    throw error
  }
}

/** Group reads and creation, injected only by SCIM resource test harnesses. */
export function scimGroups(db: Db): ScimResourceHandler {
  return (request) => {
    if (request.method === 'POST' && request.path === '/Groups') return createGroup(db, request)
    if (request.method !== 'GET' && request.method !== 'HEAD') return
    const match = /^\/Groups(?:\/([^/]*))?$/.exec(request.path)
    if (!match) return
    return match[1] === undefined ? listGroups(db, request) : readGroup(db, request, match[1])
  }
}
