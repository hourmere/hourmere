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
  remotes?: {
    type: string
    url: string
    headers?: Header[]
    variables?: Record<string, { isRequired?: boolean }>
  }[]
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

type ValidationMode = 'draft' | 'concrete' | 'template'

function validSubmissionUrl(
  remote: NonNullable<RegistryMetadata['remotes']>[number] | undefined,
  mode: Exclude<ValidationMode, 'draft'>,
): boolean {
  if (!remote) return false
  const variables = Array.from(remote.url.matchAll(/\{([^}]+)\}/g), (match) =>
    match[0].slice(1, -1),
  )
  if (
    mode === 'template' &&
    (variables.length === 0 ||
      variables.some((name) => !Object.hasOwn(remote.variables ?? {}, name)))
  ) {
    return false
  }
  if (mode === 'concrete' && /[{}<>]/.test(remote.url)) return false

  // Like the official registry, substitute placeholders only for structural checks.
  // This neither resolves DNS nor probes a user's deployment.
  const substituted = remote.url
    .replace(/:\{[^}]+\}(\/|$)/g, ':8080$1')
    .replace(/\{[^}]+\}/g, 'placeholder')
  if (/[{}<>]/.test(substituted)) return false
  try {
    const url = new URL(substituted)
    return (
      url.protocol === 'https:' &&
      url.pathname === '/mcp' &&
      !url.search &&
      !url.hash &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '[::1]' &&
      !url.hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

/** Offline validation only: never contacts an instance, logs credentials, or submits metadata. */
export function validateMcpRegistry(data: unknown, mode: ValidationMode = 'draft'): string[] {
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
    header.isRequired !== false ||
    header.isSecret !== true ||
    header.value !== undefined ||
    header.default !== undefined
  ) {
    errors.push('Describe one Streamable HTTP remote with an optional secret Authorization input.')
  }

  const status =
    data._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.['com.hourmere']
      ?.publicationStatus
  if (mode !== 'draft' && (status !== 'owner-approved' || !validSubmissionUrl(remote, mode))) {
    errors.push(
      mode === 'template'
        ? 'Submission requires owner approval and an HTTPS /mcp URL template with declared variables.'
        : 'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  }

  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const modes: string[] = args.filter(
    (arg) => arg === '--for-submission' || arg === '--for-template-submission',
  )
  const paths = args.filter((arg) => !modes.includes(arg))
  if (modes.length > 1 || paths.length > 1 || paths.some((arg) => arg.startsWith('-'))) {
    console.error(
      'Usage: node scripts/validate-mcp-registry.ts [server.json] [--for-submission | --for-template-submission]',
    )
    process.exitCode = 1
  } else {
    try {
      const input = JSON.parse(readFileSync(resolve(paths[0] ?? 'server.json'), 'utf8'))
      const mode =
        modes[0] === '--for-template-submission' ? 'template' : modes.length ? 'concrete' : 'draft'
      const errors = validateMcpRegistry(input, mode)
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
