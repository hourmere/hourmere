import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const version = '0.1.1'
const asset = `scim-outbound-for-keycloak-${version}.jar`
const release = `https://github.com/shebang-labs/scim-outbound-for-keycloak/releases/download/v${version}/${asset}`
const sha256 = 'eeadffe79790cfc38bdd7accccf1270bc7843ddd9ff4332b78b5ad1b786a52d9'
const vaultKey = 'scim-hourmere-token'
const containerVault = '/opt/keycloak/conf/scim-fixture-vault'
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const identifier = new RegExp(`^${uuid}$`)
const scimPath = new RegExp(`^/scim/v2/${uuid}$`)

async function downloadPlugin() {
  try {
    const response = await fetch(release, { signal: AbortSignal.timeout(30_000) })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
  } catch {
    // GitHub may redirect the download to a signed URL. Keep it out of test output.
  }
  throw new Error('Unable to download the pinned Keycloak SCIM plugin')
}

export async function prepareScimPlugin(directory: string) {
  const jar = await downloadPlugin()
  if (createHash('sha256').update(jar).digest('hex') !== sha256)
    throw new Error('The pinned Keycloak SCIM plugin checksum did not match')

  const jarPath = join(directory, asset)
  const vaultPath = join(directory, 'scim-vault')
  await mkdir(vaultPath, { mode: 0o700 })
  await writeFile(jarPath, jar, { mode: 0o600 })
  await Promise.all([chmod(vaultPath, 0o755), chmod(jarPath, 0o644)])
  const host = process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal'
  return {
    host,
    vaultPath,
    mounts: [
      '--mount',
      `type=bind,src=${jarPath},dst=/opt/keycloak/providers/${asset},readonly`,
      '--mount',
      `type=bind,src=${vaultPath},dst=${containerVault},readonly`,
    ],
    options: [
      '--vault=file',
      `--vault-dir=${containerVault}`,
      `--spi-scim-outbound--default--allowed-hosts=${host}`,
      '--spi-scim-outbound--default--allow-http=true',
      '--spi-scim-outbound--default--worker-interval-seconds=1',
      '--spi-scim-outbound--default--reconcile-interval-minutes=0',
    ],
  }
}

type Plugin = Awaited<ReturnType<typeof prepareScimPlugin>>

export interface KeycloakAdminOptions {
  action: string
  expectedStatus: number
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  contentType?: string
  body?: string
  readLocation?: boolean
}

type AdminRequest = (path: string, options: KeycloakAdminOptions) => Promise<string>

interface UserProfile {
  username: string
  email: string
  firstName: string
  lastName: string
}

function resourceId(value: unknown) {
  if (typeof value !== 'string' || !identifier.test(value))
    throw new Error('Keycloak fixture resources require a UUID')
  return value
}

export async function createScimRealm(plugin: Plugin, admin: AdminRequest) {
  const realm = `hourmere-scim-${randomUUID()}`
  const realmPath = `/admin/realms/${realm}`
  const targetsPath = `${realmPath}/scim-outbound/targets`
  const credentialPath = join(plugin.vaultPath, `${realm}_${vaultKey}`)
  const create = async (collection: string, action: string, representation: object) => {
    const location = await admin(`${realmPath}/${collection}`, {
      action,
      method: 'POST',
      expectedStatus: 201,
      contentType: 'application/json',
      body: JSON.stringify(representation),
      readLocation: true,
    })
    return resourceId(location.split('/').at(-1) ?? '')
  }

  await admin('/admin/realms', {
    action: 'create the owned Keycloak SCIM realm',
    method: 'POST',
    expectedStatus: 201,
    contentType: 'application/json',
    body: JSON.stringify({ realm, enabled: true, eventsListeners: ['scim-outbound'] }),
  })

  let targetId: string | undefined
  return {
    async configureTarget(baseUrl: string, credential: string) {
      const target = URL.parse(baseUrl)
      if (
        target?.protocol !== 'http:' ||
        target.hostname !== plugin.host ||
        !target.port ||
        ['3000', '3998'].includes(target.port) ||
        !scimPath.test(target.pathname) ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      )
        throw new Error('Keycloak SCIM requires a target on the owned local Hourmere server')

      // The containing temporary directory is private on the host. Keycloak mounts
      // only the vault read-only and resolves the credential inside this realm.
      await writeFile(credentialPath, credential, { flag: 'wx', mode: 0o600 })
      await chmod(credentialPath, 0o644)
      const response = await admin(targetsPath, {
        action: 'configure the owned Keycloak SCIM target',
        method: 'POST',
        expectedStatus: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'hourmere-fixture',
          baseUrl: target.href,
          auth: { type: 'BEARER', token: `\${vault.${vaultKey}}` },
          deprovision: 'DEACTIVATE',
          syncGroups: true,
        }),
      })
      try {
        targetId = resourceId(JSON.parse(response).id)
      } catch {
        throw new Error('Unable to read the owned Keycloak SCIM target identifier')
      }
    },
    createUser(user: UserProfile) {
      return create('users', 'create the synthetic Keycloak user', { ...user, enabled: true })
    },
    async updateUser(id: string, change: Partial<UserProfile & { enabled: boolean }>) {
      await admin(`${realmPath}/users/${resourceId(id)}`, {
        action: 'update the synthetic Keycloak user',
        method: 'PUT',
        expectedStatus: 204,
        contentType: 'application/json',
        body: JSON.stringify(change),
      })
    },
    createGroup(name: string) {
      return create('groups', 'create the synthetic Keycloak group', { name })
    },
    async updateGroup(id: string, name: string) {
      await admin(`${realmPath}/groups/${resourceId(id)}`, {
        action: 'update the synthetic Keycloak group',
        method: 'PUT',
        expectedStatus: 204,
        contentType: 'application/json',
        body: JSON.stringify({ name }),
      })
    },
    async close() {
      try {
        if (targetId)
          await admin(`${targetsPath}/${targetId}`, {
            action: 'delete the owned Keycloak SCIM target',
            method: 'DELETE',
            expectedStatus: 204,
          })
      } finally {
        try {
          await admin(realmPath, {
            action: 'delete the owned Keycloak SCIM realm',
            method: 'DELETE',
            expectedStatus: 204,
          })
          await admin(realmPath, {
            action: 'verify the deleted Keycloak SCIM realm is gone',
            expectedStatus: 404,
          })
        } finally {
          await rm(credentialPath, { force: true })
        }
      }
    },
  }
}
