import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'

export const MCP_REGISTRY_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'

interface Header {
  name: string
  isRequired?: boolean
  isSecret?: boolean
  value?: string
  default?: string
}

interface RegistryMetadata {
  $schema?: string
  remotes?: { type: string; url: string; headers?: Header[] }[]
  _meta?: {
    'io.modelcontextprotocol.registry/publisher-provided'?: {
      'com.hourmere'?: { publicationStatus?: string }
    }
  }
}

const schema = JSON.parse(
  readFileSync(
    new URL('./schemas/mcp-registry/server-2025-12-11.schema.json', import.meta.url),
    'utf8',
  ),
)
// The upstream schema includes documentation keywords such as `example`.
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats.default(ajv)
const validateSchema = ajv.compile<RegistryMetadata>(schema)

/** Offline validation only: never contacts an instance, logs credentials, or submits metadata. */
export function validateMcpRegistry(data: unknown, forSubmission = false): string[] {
  if (!validateSchema(data)) return ['Official MCP Registry schema validation failed.']

  const errors: string[] = []
  if (data.$schema !== MCP_REGISTRY_SCHEMA) errors.push('Use the pinned MCP Registry schema.')

  const remote = data.remotes?.[0]
  const header = remote?.headers?.[0]
  if (
    data.remotes?.length !== 1 ||
    remote?.type !== 'streamable-http' ||
    remote.headers?.length !== 1 ||
    header?.name.toLowerCase() !== 'authorization' ||
    header.isRequired !== true ||
    header.isSecret !== true ||
    header.value !== undefined ||
    header.default !== undefined
  ) {
    errors.push('Describe one Streamable HTTP remote with a required secret Authorization input.')
  }

  const status =
    data._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.['com.hourmere']
      ?.publicationStatus
  if (
    forSubmission &&
    (status !== 'owner-approved' ||
      !remote?.url.startsWith('https://') ||
      !remote.url.endsWith('/mcp') ||
      /[{}<>]/.test(remote.url))
  ) {
    errors.push('Submission requires owner approval and a concrete HTTPS /mcp URL.')
  }

  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const paths = args.filter((arg) => arg !== '--for-submission')
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('-'))) {
    console.error('Usage: node scripts/validate-mcp-registry.ts [server.json] [--for-submission]')
    process.exitCode = 1
  } else {
    try {
      const input = JSON.parse(readFileSync(resolve(paths[0] ?? 'server.json'), 'utf8'))
      const errors = validateMcpRegistry(input, args.includes('--for-submission'))
      if (errors.length) {
        for (const error of errors) console.error(error)
        process.exitCode = 1
      } else {
        console.log(
          'MCP Registry metadata validates locally. No publication or live check performed.',
        )
      }
    } catch {
      console.error('Unable to read or parse MCP Registry metadata.')
      process.exitCode = 1
    }
  }
}
