import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import realm from './realm.json' with { type: 'json' }

export const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3'

const run = promisify(execFile)
const ownerLabel = 'com.hourmere.e2e.keycloak-owner'
const containerId = /^[a-f0-9]{64}$/
const personas = realm.users.map(({ id, username, email }) => ({ subject: id, username, email }))

async function command(program: string, action: string, args: string[], timeout = 15_000) {
  try {
    return (await run(program, args, { timeout })).stdout.trim()
  } catch {
    // Child-process errors carry command arguments and stderr. Keep both out of test output.
    throw new Error(`Unable to ${action}`)
  }
}

function discoveryReady(issuer: string, ca: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(
      `${issuer}/.well-known/openid-configuration`,
      { ca, signal: AbortSignal.timeout(1000) },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.once('error', () => resolve(false))
        response.once('end', () => {
          try {
            resolve(response.statusCode === 200 && JSON.parse(body).issuer === issuer)
          } catch {
            resolve(false)
          }
        })
      },
    )
    request.once('error', () => resolve(false))
  })
}

/** Start one disposable, loopback-only IdP for a single Hourmere callback. */
export async function startKeycloak(redirectUri: string) {
  const callback = new URL(redirectUri)
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    !callback.port ||
    [3000, 3998].includes(Number(callback.port)) ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.href.includes('*')
  )
    throw new Error('Keycloak requires one exact callback on an owned Hourmere loopback port')

  const client = realm.clients[0]
  const linked = personas.find(({ username }) => username === 'linked')
  if (!client || !linked)
    throw new Error('The Keycloak realm must include its OIDC client and user')

  const owner = randomUUID()
  const name = `hourmere-e2e-keycloak-${owner}`
  const label = `${ownerLabel}=${owner}`
  await command('docker', 'find the pinned Keycloak image', [
    'image',
    'inspect',
    KEYCLOAK_IMAGE,
  ]).catch(() =>
    command('docker', 'pull the pinned Keycloak image', ['pull', KEYCLOAK_IMAGE], 120_000),
  )

  const clientSecret = randomBytes(32).toString('base64url')
  const password = randomBytes(32).toString('base64url')
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-keycloak-'))
  const importPath = join(directory, 'realm.json')
  const certificatePath = join(directory, 'tls.crt')
  const privateKeyPath = join(directory, 'tls.key')
  let creating = false
  let id: string | undefined
  const findOwnedContainer = async () => {
    const found = await command('docker', 'find the owned Keycloak container', [
      'container',
      'ls',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `name=^/${name}$`,
      '--filter',
      `label=${label}`,
    ])
    if (found && !containerId.test(found))
      throw new Error('Docker did not identify exactly one owned Keycloak container')
    return found
  }
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      try {
        // Docker may create the container before the client returns its ID. Recover
        // only the exact name and ownership label generated for this invocation.
        const ownedId = id ?? (creating ? await findOwnedContainer() : undefined)
        if (ownedId)
          await command('docker', 'remove the owned Keycloak container', ['rm', '--force', ownedId])
      } finally {
        await rm(directory, { recursive: true })
      }
    })()
    return closing
  }

  try {
    const importedRealm = {
      ...realm,
      clients: [{ ...client, secret: clientSecret, redirectUris: [callback.href] }],
      users: realm.users.map((user) => ({
        ...user,
        credentials: [{ type: 'password', value: password, temporary: false }],
      })),
    }
    // The host directory is private. Mount each file individually so Keycloak's
    // unprivileged container user can read it without access to the host directory.
    await writeFile(importPath, JSON.stringify(importedRealm))
    await command('openssl', 'generate the Keycloak TLS certificate', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
    ])
    await Promise.all(
      [importPath, certificatePath, privateKeyPath].map((path) => chmod(path, 0o644)),
    )
    const certificate = await readFile(certificatePath, 'utf8')
    creating = true
    const idFromDocker = await command(
      'docker',
      'create the Keycloak container from the pinned image',
      [
        'create',
        '--pull',
        'never',
        '--name',
        name,
        '--label',
        label,
        '--log-driver',
        'none',
        '--publish',
        '127.0.0.1::8443',
        '--mount',
        `type=bind,src=${importPath},dst=/opt/keycloak/data/import/${realm.realm}-realm.json,readonly`,
        '--mount',
        `type=bind,src=${certificatePath},dst=/opt/keycloak/conf/fixture.crt,readonly`,
        '--mount',
        `type=bind,src=${privateKeyPath},dst=/opt/keycloak/conf/fixture.key,readonly`,
        KEYCLOAK_IMAGE,
        'start-dev',
        '--import-realm',
        '--https-certificate-file=/opt/keycloak/conf/fixture.crt',
        '--https-certificate-key-file=/opt/keycloak/conf/fixture.key',
      ],
    )
    if (!containerId.test(idFromDocker)) throw new Error('Docker did not return a container ID')
    id = idFromDocker
    await command('docker', 'start the owned Keycloak container', ['start', id])
    const mapping = await command('docker', 'read the owned Keycloak port', [
      'port',
      id,
      '8443/tcp',
    ])
    const port = /^127\.0\.0\.1:([0-9]+)$/.exec(mapping)?.[1]
    if (!port || [3000, 3998].includes(Number(port)))
      throw new Error('Docker must publish Keycloak on an unused loopback port')

    const origin = `https://127.0.0.1:${port}`
    const issuer = `${origin}/realms/${realm.realm}`
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (await discoveryReady(issuer, certificate))
        return {
          origin,
          issuer,
          clientId: client.clientId,
          clientSecret,
          certificate,
          password,
          linked,
          personas,
          close,
        }
      await delay(250)
    }
    throw new Error('The owned Keycloak realm did not publish discovery before its deadline')
  } catch (error) {
    await close()
    throw error
  }
}
