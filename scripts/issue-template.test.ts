import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const config = parse(
  readFileSync(
    process.env.HOURMERE_ISSUE_TEMPLATE_CONFIG ??
      new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url),
    'utf8',
  ),
) as {
  blank_issues_enabled: boolean
  contact_links: { name: string; url: string; about: string }[]
}

describe('issue template contact channels', () => {
  it('keeps blank issues disabled', () => {
    expect(config.blank_issues_enabled).toBe(false)
  })

  it('keeps the private security reporting contact', () => {
    expect(config.contact_links).toContainEqual({
      name: 'Report a security vulnerability',
      url: 'https://github.com/hourmere/hourmere/security/policy',
      about:
        'Please report vulnerabilities privately as described in SECURITY.md, not in a public issue.',
    })
  })

  it('directs questions to docs and email, reserving issues for bugs and features', () => {
    const help = config.contact_links.find((link) => link.name === 'Questions and help')
    expect(help).toBeDefined()
    expect(help?.url).toBe('https://hourmere.com/docs')
    expect(help?.about).toContain('support@hourmere.com')
    expect(help?.about).toMatch(/read the docs/i)
    expect(help?.about).toMatch(/issues only for bug reports and feature requests/i)
  })
})
