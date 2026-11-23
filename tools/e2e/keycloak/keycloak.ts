import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { sendSsoRequest } from '../../../packages/outbound/src/sso.ts'
import realm from './realm.json' with { type: 'json' }

const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3'

const run = promisify(execFile)
const ownerLabel = 'com.hourmere.e2e.keycloak-owner'
const containerId = /^[a-f0-9]{64}$/
const adminClientId = 'fixture-key-rotation'

function persona(name: string) {
  const user = realm.users.find((entry) => entry.username === name)
  if (!user) throw new Error(`The Keycloak realm is missing the ${name} persona`)
  return { subject: user.id, username: user.username, email: user.email }
}

async function command(program: string, action: string, args: string[], timeout = 15_000) {
  try {
    return (await run(program, args, { timeout })).stdout.trim()
  } catch {
    // Child-process errors carry command arguments and stderr. Keep both out of test output.
    throw new Error(`Unable to ${action}`)
  }
}

function discoveryStatus(issuer: string, ca: string): Promise<string> {
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
        response.once('error', () => resolve('response interrupted'))
        response.once('end', () => {
          if (response.statusCode !== 200) return resolve(`HTTP ${response.statusCode}`)
          try {
            resolve(JSON.parse(body).issuer === issuer ? 'ready' : 'issuer did not match')
          } catch {
            resolve('invalid discovery response')
          }
        })
      },
    )
    request.once('error', () => resolve('HTTPS connection unavailable'))
  })
}

async function addSigningKey(origin: string, adminSecret: string) {
  const { hostname, port } = new URL(origin)
  const privateTargets = [{ host: hostname, port: Number(port) }]
  const adminRealm = `${origin}/admin/realms/${realm.realm}`
  try {
    const token = await sendSsoRequest({
      url: `${origin}/realms/master/protocol/openid-connect/token`,
      privateTargets,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: adminClientId,
        client_secret: adminSecret,
      }).toString(),
    })
    if (token.status !== 200) throw new Error()
    const { access_token: accessToken } = JSON.parse(token.body.toString('utf8'))
    if (typeof accessToken !== 'string' || !accessToken) throw new Error()
    const authorization = `Bearer ${accessToken}`
    const metadata = await sendSsoRequest({
      url: adminRealm,
      privateTargets,
      headers: { authorization },
    })
    if (metadata.status !== 200) throw new Error()
    const { id: parentId } = JSON.parse(metadata.body.toString('utf8'))
    if (typeof parentId !== 'string' || !parentId) throw new Error()
    const created = await sendSsoRequest({
      url: `${adminRealm}/components`,
      privateTargets,
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'rotated-fixture-signing-key',
        parentId,
        providerId: 'rsa-generated',
        providerType: 'org.keycloak.keys.KeyProvider',
        config: {
          priority: ['200'],
          enabled: ['true'],
          active: ['true'],
          algorithm: ['RS256'],
          keySize: ['2048'],
        },
      }),
    })
    if (created.status !== 201) throw new Error()
  } catch {
    // The admin response may contain private credentials or key configuration.
    throw new Error('Unable to rotate the owned Keycloak realm signing key')
  }
}

/** Start one disposable, loopback-only IdP for a single Hourmere callback. */
export async function startKeycloak(
  redirectUri: string,
  { keyRotation }: { keyRotation: boolean },
) {
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
  if (!client) throw new Error('The Keycloak realm is missing its OIDC client')
  const personas = {
    linked: persona('linked'),
    linkable: persona('linkable'),
    sameEmail: persona('same-email'),
    unverified: persona('unverified'),
    invited: persona('invited'),
  }

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
  const adminSecret = keyRotation ? randomBytes(32).toString('base64url') : undefined
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-keycloak-'))
  const importPath = join(directory, 'realm.json')
  const certificatePath = join(directory, 'tls.crt')
  const privateKeyPath = join(directory, 'tls.key')
  const adminEnvironment = join(directory, 'admin.env')
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
    if (adminSecret)
      await writeFile(
        adminEnvironment,
        `KC_BOOTSTRAP_ADMIN_CLIENT_ID=${adminClientId}\nKC_BOOTSTRAP_ADMIN_CLIENT_SECRET=${adminSecret}\n`,
        { mode: 0o600 },
      )
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
        ...(adminSecret ? ['--env-file', adminEnvironment] : []),
        // These short-lived JVMs run side by side with Chrome and PostgreSQL in CI.
        '--env',
        'JAVA_OPTS_APPEND=-XX:ActiveProcessorCount=2 -XX:TieredStopAtLevel=1',
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
        '--db=dev-mem',
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
    let discovery = 'not checked'
    while (Date.now() < deadline) {
      discovery = await discoveryStatus(issuer, certificate)
      if (discovery === 'ready')
        return {
          origin,
          issuer,
          clientId: client.clientId,
          clientSecret,
          certificate,
          password,
          ...personas,
          async rotateSigningKey() {
            if (!adminSecret) throw new Error('This fixture did not enable Keycloak key rotation')
            await addSigningKey(origin, adminSecret)
          },
          async stop() {
            await command('docker', 'stop the owned Keycloak container', [
              'stop',
              '--time',
              '0',
              idFromDocker,
            ])
          },
          close,
        }
      await delay(250)
    }
    const state = await command(
      'docker',
      'read the owned Keycloak state',
      [
        'container',
        'inspect',
        '--format',
        '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}',
        id,
      ],
      2000,
    ).catch(() => '')
    const safeState =
      /^(running|exited|dead|restarting|created|paused|removing) \d{1,3} (true|false)$/.test(state)
        ? state
        : 'unavailable'
    throw new Error(
      `The owned Keycloak realm did not publish discovery before its deadline (${discovery}, Docker state/exit/OOM ${safeState})`,
    )
  } catch (error) {
    await close()
    throw error
  }
}
