import { describe, expect, it } from 'vitest'
import { fakeApi, json, ME, PROFILE, signedInAs } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'
import { verifySlotPickerAccess } from './slot-picker-access.ts'

const team = { ...ME, organization: { ...ME.organization, personal: false, slug: 'team' } }
const memberRoute = 'GET /api/auth/organization/get-active-member'
const event = eventType()
const eventRoute = `GET /api/v1/event-types/${event.id}`
const membership = {
  id: 'membership',
  organizationId: ME.organization.id,
  userId: ME.user.id,
  role: 'owner',
}

describe('fresh slot picker permission checks', () => {
  it('allows the current saved personal owner', async () => {
    const api = fakeApi({
      ...signedInAs(ME),
      'GET /api/v1/profile': () => json(200, PROFILE),
      [eventRoute]: () => json(200, event),
    })
    await expect(verifySlotPickerAccess(ME, event, PROFILE)).resolves.toBeUndefined()
    expect(api.to('GET /api/v1/me')).toHaveLength(1)
    expect(api.to(eventRoute)).toHaveLength(1)
  })

  it.each(['owner', 'admin', 'member,admin'])('allows a current team %s', async (role) => {
    const saved = eventType({ ownerUserId: null })
    fakeApi({
      ...signedInAs(team),
      [memberRoute]: () => json(200, { ...membership, role }),
      [eventRoute]: () => json(200, saved),
    })
    await expect(verifySlotPickerAccess(team, saved, PROFILE)).resolves.toBeUndefined()
  })

  it.each(['member', '', 'admin,unknown'])(
    'refuses team role %s even for an event host',
    async (role) => {
      fakeApi({
        ...signedInAs(team),
        [memberRoute]: () => json(200, { ...membership, role }),
      })
      await expect(
        verifySlotPickerAccess(team, eventType({ ownerUserId: null }), PROFILE),
      ).rejects.toThrow('picker_access_denied')
    },
  )

  it.each([
    { ...ME, user: { ...ME.user, id: 'different-user' } },
    { ...ME, organization: { ...ME.organization, id: 'different-organization' } },
    { ...ME, principal: { kind: 'api_key' as const, apiKeyId: 'key' } },
  ])('refuses a changed identity or organization', async (current) => {
    fakeApi(signedInAs(current))
    await expect(verifySlotPickerAccess(ME, event, PROFILE)).rejects.toThrow(
      'picker_context_changed',
    )
  })

  it('refuses a foreign event or another personal owner', async () => {
    fakeApi(signedInAs(ME))
    await expect(
      verifySlotPickerAccess(ME, eventType({ organizationId: 'foreign' }), PROFILE),
    ).rejects.toThrow('picker_access_denied')
    await expect(
      verifySlotPickerAccess(ME, eventType({ ownerUserId: 'another-owner' }), PROFILE),
    ).rejects.toThrow('picker_access_denied')
  })

  it.each([
    { ...membership, organizationId: 'foreign' },
    { ...membership, userId: 'other-user' },
  ])('refuses a member read from another context', async (member) => {
    fakeApi({ ...signedInAs(team), [memberRoute]: () => json(200, member) })
    await expect(
      verifySlotPickerAccess(team, eventType({ ownerUserId: null }), PROFILE),
    ).rejects.toThrow('picker_access_denied')
  })

  it.each([401, 403, 429, 500])('does not reuse a cached role after HTTP %i', async (status) => {
    fakeApi({ ...signedInAs(team), [memberRoute]: () => json(status, { code: 'unavailable' }) })
    await expect(
      verifySlotPickerAccess(team, eventType({ ownerUserId: null }), PROFILE),
    ).rejects.toBeDefined()
  })

  it.each([
    { slug: 'changed' },
    { title: 'Changed title' },
    { updatedAt: '2027-01-01T00:00:00.000Z' },
    { isActive: false },
    { ownerUserId: 'other-owner' },
  ])('requires reopening an event changed since the saved view', async (change) => {
    fakeApi({
      ...signedInAs(ME),
      'GET /api/v1/profile': () => json(200, PROFILE),
      [eventRoute]: () => json(200, eventType(change)),
    })
    await expect(verifySlotPickerAccess(ME, event, PROFILE)).rejects.toThrow('picker_event_changed')
  })

  it('refuses a renamed saved profile handle', async () => {
    fakeApi({
      ...signedInAs(ME),
      'GET /api/v1/profile': () => json(200, { ...PROFILE, handle: 'renamed' }),
    })
    await expect(verifySlotPickerAccess(ME, event, PROFILE)).rejects.toThrow('picker_event_changed')
  })
})
