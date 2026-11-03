import { getActiveOrganizationMember } from '../../api/auth.ts'
import { api, unwrap } from '../../api/client.ts'
import { type EventType, loadProfile, type Profile } from '../../api/resources.ts'
import type { Me } from '../../session.tsx'

/** Fresh reads only: cached management access may survive a failed background refresh. */
export async function verifySlotPickerAccess(me: Me, event: EventType, profile: Profile | null) {
  const current = await unwrap(api.GET('/api/v1/me'))
  if (
    current.principal.kind !== 'session' ||
    current.user.id !== me.user.id ||
    current.organization.id !== me.organization.id
  )
    throw new Error('picker_context_changed')
  if (event.organizationId !== current.organization.id) throw new Error('picker_access_denied')
  if (event.ownerUserId !== null) {
    if (event.ownerUserId !== current.user.id) throw new Error('picker_access_denied')
    const savedProfile = await loadProfile(new AbortController().signal)
    if (!profile || savedProfile?.handle !== profile.handle) throw new Error('picker_event_changed')
  } else {
    if (current.organization.personal || current.organization.slug !== me.organization.slug)
      throw new Error('picker_access_denied')
    const member = await getActiveOrganizationMember()
    const roles = member.role.split(',').map((role) => role.trim())
    if (
      member.organizationId !== me.organization.id ||
      member.userId !== me.user.id ||
      !roles.some((role) => role === 'owner' || role === 'admin') ||
      roles.some((role) => !['owner', 'admin', 'member'].includes(role))
    )
      throw new Error('picker_access_denied')
  }
  const saved = await unwrap(
    api.GET('/api/v1/event-types/{id}', { params: { path: { id: event.id } } }),
  )
  if (
    saved.id !== event.id ||
    saved.organizationId !== me.organization.id ||
    saved.ownerUserId !== event.ownerUserId ||
    saved.updatedAt !== event.updatedAt ||
    saved.slug !== event.slug ||
    saved.title !== event.title ||
    !saved.isActive
  )
    throw new Error('picker_event_changed')
}
