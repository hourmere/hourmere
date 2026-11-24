import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareScimPlugin } from '../tools/e2e/keycloak/scim-plugin.ts'

it('rejects a mismatched release before writing a mountable plugin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-plugin-test-'))
  const download = vi.fn(async () => new Response('synthetic invalid JAR'))
  vi.stubGlobal('fetch', download)
  try {
    await expect(prepareScimPlugin(directory)).rejects.toThrow('checksum did not match')
    expect(download).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/shebang-labs/scim-outbound-for-keycloak/releases/download/v0.1.1/scim-outbound-for-keycloak-0.1.1.jar',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(await readdir(directory)).toEqual([])
  } finally {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true })
  }
})
