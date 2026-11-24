import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { get, request } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import realm from './realm.json' with { type: 'json' }

const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3'

const run = promisify(execFile)
const ownerLabel = 'com.hourmere.e2e.keycloak-owner'
const containerId = /^[a-f0-9]{64}$/
const adminClientId = 'fixture-admin'

function persona(users: typeof realm.users, name: string) {
  const user = users.find((entry) => entry.username === name)
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

/** Reserve a loopback port for a container that shares the host network. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('Unable to reserve a loopback port')),
      )
    })
  })
}

/** Fetch one Keycloak page and discard it to warm a fresh realm. */
function warm(url: string, ca: string): Promise<void> {
  return new Promise((resolve) => {
    const request = get(url, { ca, signal: AbortSignal.timeout(10_000) }, (response) => {
      response.resume()
      response.once('error', () => resolve())
      response.once('end', () => resolve())
    })
    request.once('error', () => resolve())
  })
}

interface KeycloakRequestOptions {
  action: string
  expectedStatus: number
  method?: 'GET' | 'POST' | 'DELETE'
  authorization?: string
  contentType?: string
  body?: string
}

function keycloakRequest(
  url: string,
  ca: string,
  { action, expectedStatus, method, authorization, contentType, body }: KeycloakRequestOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error(`Unable to ${action}`))
    // All URLs are built from the owned loopback origin and TLS pins that container's CA.
    // Never follow a redirect or include a response, credential or request error in output.
    const req = request(
      url,
      {
        ca,
        method,
        signal: AbortSignal.timeout(10_000),
        headers: {
          ...(authorization && { authorization }),
          ...(contentType && { 'content-type': contentType }),
          ...(body && { 'content-length': Buffer.byteLength(body) }),
        },
      },
      async (response) => {
        try {
          const payload = await text(response)
          if (response.statusCode !== expectedStatus)
            reject(new Error(`Unable to ${action} (HTTP ${response.statusCode})`))
          else resolve(payload)
        } catch {
          failed()
        }
      },
    )
    req.once('error', failed)
    req.end(body)
  })
}

function readJsonStringField(payload: string, field: string, action: string): string {
  try {
    const value = JSON.parse(payload)[field]
    if (typeof value === 'string' && value) return value
  } catch {
    // The admin response may contain private credentials or key configuration.
  }
  throw new Error(`Unable to ${action}`)
}

function realmFactory(origin: string, ca: string, adminSecret: string) {
  const admin = (path: string, options: KeycloakRequestOptions) =>
    keycloakRequest(`${origin}${path}`, ca, options)
  const authorize = async () => {
    const action = 'authenticate the owned Keycloak fixture admin'
    const payload = await admin('/realms/master/protocol/openid-connect/token', {
      action,
      expectedStatus: 200,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: adminClientId,
        client_secret: adminSecret,
      }).toString(),
    })
    return `Bearer ${readJsonStringField(payload, 'access_token', action)}`
  }

  return async (redirectUri: string) => {
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
    const name = `${realm.realm}-${randomUUID()}`
    const issuer = `${origin}/realms/${name}`
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`
    const adminRealm = `/admin/realms/${name}`
    const clientSecret = randomBytes(32).toString('base64url')
    const password = randomBytes(32).toString('base64url')
    const users = realm.users.map((user) => ({
      ...user,
      id: randomUUID(),
      credentials: [{ type: 'password', value: password, temporary: false }],
    }))
    const personas = {
      linked: persona(users, 'linked'),
      linkable: persona(users, 'linkable'),
      sameEmail: persona(users, 'same-email'),
      unverified: persona(users, 'unverified'),
      invited: persona(users, 'invited'),
    }
    await admin('/admin/realms', {
      action: 'create the owned Keycloak test realm',
      expectedStatus: 201,
      method: 'POST',
      authorization: await authorize(),
      contentType: 'application/json',
      body: JSON.stringify({
        ...realm,
        realm: name,
        // These random passwords are disposable. Argon2 delayed sign-in with parallel CI workers.
        passwordPolicy: 'hashAlgorithm(pbkdf2-sha256) and hashIterations(1)',
        clients: [{ ...client, secret: clientSecret, redirectUris: [callback.href] }],
        users,
      }),
    })

    const close = async () => {
      await admin(adminRealm, {
        action: 'delete the owned Keycloak test realm',
        expectedStatus: 204,
        method: 'DELETE',
        authorization: await authorize(),
      })
      await keycloakRequest(discoveryUrl, ca, {
        action: 'verify the deleted Keycloak test realm is gone',
        expectedStatus: 404,
      })
    }

    try {
      const action = 'read the owned Keycloak test realm discovery'
      const discovery = await keycloakRequest(discoveryUrl, ca, { action, expectedStatus: 200 })
      if (readJsonStringField(discovery, 'issuer', action) !== issuer)
        throw new Error('The Keycloak test realm discovery issuer did not match')
      // Load the realm's login form and signing keys before the browser's first round trip.
      const authorizeUrl = new URL(`${issuer}/protocol/openid-connect/auth`)
      authorizeUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: callback.href,
        response_type: 'code',
        scope: 'openid',
      }).toString()
      await Promise.all([
        warm(authorizeUrl.href, ca),
        warm(`${issuer}/protocol/openid-connect/certs`, ca),
      ])
    } catch (error) {
      await close()
      throw error
    }

    return {
      issuer,
      clientId: client.clientId,
      clientSecret,
      certificate: ca,
      password,
      ...personas,
      close,
      async rotateSigningKey() {
        const authorization = await authorize()
        const action = 'rotate the owned Keycloak realm signing key'
        const metadata = await admin(adminRealm, { action, expectedStatus: 200, authorization })
        const parentId = readJsonStringField(metadata, 'id', action)
        await admin(`${adminRealm}/components`, {
          action,
          expectedStatus: 201,
          method: 'POST',
          authorization,
          contentType: 'application/json',
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
      },
    }
  }
}

/** Start one disposable, loopback-only IdP for a worker or a disruptive test. */
export async function startKeycloak() {
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

  const adminSecret = randomBytes(32).toString('base64url')
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-keycloak-'))
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
    await writeFile(
      adminEnvironment,
      `KC_BOOTSTRAP_ADMIN_CLIENT_ID=${adminClientId}\nKC_BOOTSTRAP_ADMIN_CLIENT_SECRET=${adminSecret}\n`,
      { mode: 0o600 },
    )
    // The host directory is private. Mount each file individually so Keycloak's
    // unprivileged container user can read it without access to the host directory.
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
    await Promise.all([certificatePath, privateKeyPath].map((path) => chmod(path, 0o644)))
    const certificate = await readFile(certificatePath, 'utf8')
    // A bridge network adds and removes a host interface for every container. Chrome on the same
    // Linux host then aborts whatever navigation is in flight ("Your connection was interrupted"),
    // in this test or in the one running beside it. Host networking changes no interface.
    const hostPort = process.platform === 'linux' ? await freeLoopbackPort() : undefined
    const plainPort = hostPort ? await freeLoopbackPort() : undefined
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
        '--env-file',
        adminEnvironment,
        // These short-lived JVMs run side by side with Chrome and PostgreSQL in CI.
        '--env',
        'JAVA_OPTS_APPEND=-XX:ActiveProcessorCount=2 -XX:TieredStopAtLevel=1',
        ...(hostPort ? ['--network', 'host'] : ['--publish', '127.0.0.1::8443']),
        '--mount',
        `type=bind,src=${certificatePath},dst=/opt/keycloak/conf/fixture.crt,readonly`,
        '--mount',
        `type=bind,src=${privateKeyPath},dst=/opt/keycloak/conf/fixture.key,readonly`,
        KEYCLOAK_IMAGE,
        'start-dev',
        '--db=dev-mem',
        '--https-certificate-file=/opt/keycloak/conf/fixture.crt',
        '--https-certificate-key-file=/opt/keycloak/conf/fixture.key',
        ...(hostPort
          ? [
              '--http-host=127.0.0.1',
              `--https-port=${hostPort}`,
              // Development mode keeps a plain HTTP listener; give it its own loopback port too.
              `--http-port=${plainPort}`,
            ]
          : []),
      ],
    )
    if (!containerId.test(idFromDocker)) throw new Error('Docker did not return a container ID')
    id = idFromDocker
    await command('docker', 'start the owned Keycloak container', ['start', id])
    const mapping = hostPort
      ? `127.0.0.1:${hostPort}`
      : await command('docker', 'read the owned Keycloak port', ['port', id, '8443/tcp'])
    const port = /^127\.0\.0\.1:([0-9]+)$/.exec(mapping)?.[1]
    if (!port || [3000, 3998].includes(Number(port)))
      throw new Error('Docker must publish Keycloak on an unused loopback port')

    const origin = `https://127.0.0.1:${port}`
    const issuer = `${origin}/realms/master`
    const deadline = Date.now() + 45_000
    let discovery = 'not checked'
    while (Date.now() < deadline) {
      discovery = await discoveryStatus(issuer, certificate)
      if (discovery === 'ready') {
        return {
          createRealm: realmFactory(origin, certificate, adminSecret),
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
      `The owned Keycloak container did not publish discovery before its deadline (${discovery}, Docker state/exit/OOM ${safeState})`,
    )
  } catch (error) {
    await close()
    throw error
  }
}
