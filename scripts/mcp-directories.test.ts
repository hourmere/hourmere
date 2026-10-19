import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const guide = readFileSync(new URL('../docs/mcp-directories.md', import.meta.url), 'utf8')
const section = (heading: string) => guide.split(`## ${heading}\n`)[1]?.split('\n## ')[0]

describe('MCP directory submission guidance', () => {
  it('requires directory confirmation before relying on patterns for arbitrary customer hosts', () => {
    const claude = section('Claude Connectors Directory — owner review')?.replace(/\s+/g, ' ')
    expect(claude).toContain('may fit independent self-hosted instances')
    expect(claude).toContain(
      'Before relying on this route, confirm with the directory whether reviewers accept a pattern covering arbitrary customer hosts.',
    )
    expect(claude).not.toContain('supports independent self-hosted instances')
  })

  it('does not infer a currency from the mcp.so submission fee', () => {
    const mcpSo = section('mcp.so — owner submission and payment decision')?.replace(/\s+/g, ' ')
    expect(mcpSo).toContain('one-time fee of 39 (currency not stated)')
    expect(mcpSo).not.toMatch(/US\$|USD|\$39/)
  })
})
