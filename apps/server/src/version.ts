import manifest from '../../../package.json' with { type: 'json' }

/** Product version shared by the OpenAPI document and MCP server identity. */
export const VERSION = manifest.version
