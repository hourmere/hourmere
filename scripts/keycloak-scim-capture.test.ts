import { expect, it } from 'vitest'
import { createScimCapture } from '../tools/e2e/keycloak/scim-capture.ts'

const user = 'c33bc18f-6f0a-4017-8df3-3e11f6dfbf46'
const group = 'f2f3e854-335c-4e70-95c7-a301c71143c7'
const organization = '206f7dc6-1b22-4289-b31b-858a1f661410'
const fixtureOrigin = 'http://fixture-origin.example.test'
const base = `${fixtureOrigin}/scim/v2/${organization}`

it('retains SCIM lookup and mutation semantics with stable resource aliases', async () => {
  const email = 'alex@fixture.example.test'
  const capture = createScimCapture([email])
  const query = new URLSearchParams({ filter: `userName eq "${email}"` })
  const lookup = { totalResults: 1, Resources: [{ id: user, userName: email, active: true }] }
  const found = await capture.fetch(new Request(`${base}/Users?${query}`), () =>
    Response.json(lookup),
  )
  expect(await found.json()).toEqual(lookup)

  const operations = [{ op: 'remove', path: `members[value eq "${user}"]` }]
  const removed = { id: group, members: [] }
  await capture.fetch(
    new Request(`${base}/Groups/${group}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/scim+json' },
      body: JSON.stringify({ Operations: operations }),
    }),
    async (request) => {
      expect(await request.json()).toEqual({ Operations: operations })
      return Response.json(removed)
    },
  )
  expect(capture.entries).toEqual([
    {
      method: 'GET',
      path: '/Users',
      query: { filter: `userName eq "${email}"` },
      status: 200,
      response: { totalResults: 1, Resources: [{ id: 'user-1', userName: email, active: true }] },
    },
    {
      method: 'PATCH',
      path: '/Groups/group-1',
      request: { Operations: [{ op: 'remove', path: 'members[value eq "user-1"]' }] },
      status: 200,
      response: { id: 'group-1', members: [] },
    },
  ])
})

it('excludes credentials and arbitrary strings from request and response capture', async () => {
  const marker = 'synthetic-credential-marker'
  const capture = createScimCapture()
  const json = { userName: marker, password: marker, [marker]: marker }
  const query = new URLSearchParams({ filter: `userName eq "${marker}"`, token: marker })
  const response = await capture.fetch(
    new Request(`${base}/Users?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/scim+json', Authorization: `Bearer ${marker}` },
      body: JSON.stringify(json),
    }),
    async (request) => {
      expect(request.headers.get('Authorization')).toBe(`Bearer ${marker}`)
      expect(await request.json()).toEqual(json)
      return Response.json(
        {
          status: '400',
          scimType: 'invalidValue',
          detail: marker,
          meta: { location: `${base}/Users/${user}` },
        },
        { status: 400, headers: { 'Set-Cookie': `session=${marker}` } },
      )
    },
  )

  expect(response.headers.get('Set-Cookie')).toBe(`session=${marker}`)
  const captureJson = JSON.stringify(capture.entries)
  expect(captureJson).not.toContain(marker)
  expect(captureJson).not.toContain(fixtureOrigin)
  expect(captureJson).not.toContain(organization)
  expect(capture.entries).toEqual([
    {
      method: 'POST',
      path: '/Users',
      query: { filter: 'userName eq "[redacted]"' },
      request: { userName: '[redacted]' },
      status: 400,
      response: { status: '400', scimType: 'invalidValue' },
    },
  ])
})

it('bounds discarded bodies and leaves the complete stream available to Hourmere', async () => {
  const capture = createScimCapture()
  const body = JSON.stringify({ detail: 'x'.repeat(64 * 1024) })
  const response = await capture.fetch(
    new Request(`${base}/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/scim+json' },
      body,
    }),
    async (request) => {
      expect(await request.text()).toBe(body)
      return new Response(null, { status: 204 })
    },
  )
  expect(response.status).toBe(204)
  expect(capture.entries).toEqual([
    { method: 'POST', path: '/Users', request: '[redacted]', status: 204 },
  ])
})
