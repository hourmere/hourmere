// An opt-in storage-only acceptance gate. Capture this script's output at the chosen
// main commit, then pass that file as STORAGE_INTERFACE_BASELINE to the focused test.
// Deliberately no permanent product snapshot: later interface steps may add surfaces.
import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { createDb, createPool } from '@hourmere/db'
import { prepareTools } from '../apps/server/src/mcp/tools.ts'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { productTools } from '../apps/server/src/server.ts'
import { COMMANDS, REST_COMMANDS } from '../tools/cli/src/cli.ts'

export const INTERFACE_SURFACES = ['openapi', 'mcp', 'cli', 'webRoutes'] as const
export type StorageInterfaceSnapshot = Record<(typeof INTERFACE_SURFACES)[number], string>

export async function storageInterfaceSnapshot(): Promise<StorageInterfaceSnapshot> {
  // No handlers run, and no connections are opened. Still close the pool explicitly.
  const db = createDb(createPool('postgres://storage-interface@127.0.0.1:9/storage-interface'))
  try {
    return {
      openapi: JSON.stringify(await openApiDocument()),
      mcp: JSON.stringify(
        prepareTools(productTools({ db })).map(({ tool, inputSchema, outputSchema }) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          annotations: tool.annotations,
          inputSchema: inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
          outputSchema: outputSchema['~standard'].jsonSchema.output({ target: 'draft-07' }),
        })),
      ),
      cli: JSON.stringify({ commands: COMMANDS, restCommands: REST_COMMANDS }),
      // Comparing source bytes also catches route elements, guards and lazy imports;
      // a path-only inventory could miss an accidentally mounted feature page.
      webRoutes: JSON.stringify(
        ['App.tsx', 'paths.ts', 'lazy-pages.tsx', 'main.tsx'].map((file) => [
          file,
          readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'),
        ]),
      ),
    }
  } finally {
    await db.destroy()
  }
}

export function assertStorageInterfacesUnchanged(
  baseline: StorageInterfaceSnapshot,
  current: StorageInterfaceSnapshot,
) {
  for (const surface of INTERFACE_SURFACES) {
    assert.equal(typeof baseline[surface], 'string', `Missing baseline: ${surface}`)
    assert.equal(current[surface], baseline[surface], `Storage-only change altered ${surface}`)
  }
}

if (import.meta.main) {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: node scripts/storage-interface-snapshot.ts OUTPUT.json')
  writeFileSync(output, JSON.stringify(await storageInterfaceSnapshot()))
}
