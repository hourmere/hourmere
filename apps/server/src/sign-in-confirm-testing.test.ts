import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { inlineAsset, pressConfirmButton } from './sign-in-confirm-testing.ts'

describe('sign-in confirmation test support', () => {
  it.each(['production', 'development', undefined])('refuses import in NODE_ENV=%s', (mode) => {
    const env = { ...process.env }
    if (mode === undefined) delete env.NODE_ENV
    else env.NODE_ENV = mode
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'await import(process.argv[1])',
        new URL('./sign-in-confirm-testing.ts', import.meta.url).href,
      ],
      { env, encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Sign-in confirmation test support requires NODE_ENV=test')
  })

  it.each(['script', 'SCRIPT', 'ScRiPt'])(
    'parses an actual %s element, ignoring comments',
    (tag) => {
      const source = '\nconst text = "<script>";\n'
      expect(
        inlineAsset(`<!-- <script>wrong</script> --><${tag}>${source}</${tag}>`, 'script'),
      ).toBe(source)
    },
  )

  it('preserves raw style source when checking its CSP hash', () => {
    const source = '\nbody::after { content: "<>&"; }\n'
    expect(inlineAsset(`<STYLE>${source}</STYLE>`, 'style')).toBe(source)
  })

  it.each([
    '',
    '<!-- <script>comment only</script> -->',
    '<script src="/external.js"></script>',
    '<script>one()</script><script>two()</script>',
  ])('rejects missing, external or ambiguous executable script (%#)', (html) => {
    expect(() => inlineAsset(html, 'script')).toThrow(
      'confirm page must have exactly one inline script',
    )
  })

  it('reads GET-form attributes through the HTML parser regardless of case and order', async () => {
    const html = `
      <FORM action="/api/auth/magic-link/verify" method="GET" id="confirm"></FORM>
      <SCRIPT>
        const form = document.getElementById('confirm');
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'token';
        input.value = new URLSearchParams(location.hash.slice(1)).get('token');
        form.append(input);
        form.hidden = false;
      </SCRIPT>`
    const result = await pressConfirmButton(
      { request: () => new Response(html) },
      new URL('https://hourmere.example/sign-in/confirm#token=synthetic'),
    )
    expect(result.pathname).toBe('/api/auth/magic-link/verify')
    expect(result.searchParams.get('token')).toBe('synthetic')
  })

  it.each([
    '<form id="confirm" action="/verify" method="post"></form>',
    '<form id="confirm" method="get"></form>',
    '<form id="confirm" action="/one" method="get"></form><form id="confirm" action="/two" method="get"></form>',
  ])('rejects a non-GET, incomplete or ambiguous confirmation form (%#)', async (form) => {
    await expect(
      pressConfirmButton(
        { request: () => new Response(`${form}<script>unused()</script>`) },
        new URL('https://hourmere.example/sign-in/confirm#token=synthetic'),
      ),
    ).rejects.toThrow('confirm page must have exactly one confirmation GET form')
  })
})
