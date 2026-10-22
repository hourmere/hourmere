// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import postcss, { type AtRule } from 'postcss'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupWaitlistForms, waitlistMessages } from './waitlist-client'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const formMarkup = (id: string) => `
  <div id="${id}-waitlist"><form action="/api/waitlist" method="post" data-waitlist-form>
    <input name="email" type="email" value="" aria-describedby="${id}-consent" />
    <input name="hm_extra" value="" />
    <input name="locale" value="en" />
    <input name="source" value="${id}" />
    <button type="submit">Join the Cloud waitlist</button>
    <p id="${id}-consent">We'll email you when Hourmere Cloud launches.</p>
    <p id="${id}-status" tabindex="-1" role="status" data-waitlist-status></p>
  </form></div>`

const getForm = (index = 0) => {
  const form = document.querySelectorAll<HTMLFormElement>('form')[index]
  const status = form?.querySelector<HTMLElement>('[data-waitlist-status]')
  const button = form?.querySelector<HTMLButtonElement>('button')
  const email = form?.querySelector<HTMLInputElement>('input[name="email"]')
  if (!form || !status || !button || !email) throw new Error('Missing waitlist fixture')
  return { form, status, button, email }
}

const submit = async () => {
  const controls = getForm()
  controls.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(controls.button.disabled).toBe(false))
  return controls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('waitlist progressive enhancement', () => {
  beforeEach(() => {
    document.body.innerHTML = formMarkup('cloud') + formMarkup('pricing')
    setupWaitlistForms(document)
    getForm().email.value = 'visitor@example.com'
  })

  it('submits only the existing form fields to the same-origin endpoint and requests JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { form, status, email } = await submit()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(form.action)
    expect(new URL(url).pathname).toBe('/api/waitlist')
    expect(new URL(url).origin).toBe(location.origin)
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ Accept: 'application/json' })
    expect([...options.body.entries()]).toEqual([
      ['email', 'visitor@example.com'],
      ['hm_extra', ''],
      ['locale', 'en'],
      ['source', 'cloud'],
    ])
    expect(status.dataset.state).toBe('success')
    expect(status.textContent).toBe("Thanks. We'll email you when Hourmere Cloud launches.")
    expect(document.activeElement).toBe(status)
    expect(email.value).toBe('')
    expect(getForm(1).status.textContent).toBe('')
  })

  it('disables duplicate submissions while a request is in flight and restores the form', async () => {
    let complete: (response: Response) => void = () => {}
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { form, button, status } = getForm()
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(button.disabled).toBe(true)
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(status.textContent).toBe('Joining the waitlist…')
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(fetchMock).toHaveBeenCalledOnce()
    complete(new Response('{}', { status: 200 }))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(form.hasAttribute('aria-busy')).toBe(false)
  })

  it('shows a fixed success message without rendering any response body or submitted address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"message":"visitor@example.com already exists <img src=x>"}', {
          status: 200,
        }),
      ),
    )
    const { status } = await submit()
    expect(status.textContent).toBe("Thanks. We'll email you when Hourmere Cloud launches.")
    expect(status.querySelector('img')).toBeNull()
  })

  it.each([
    [400, 'Enter one valid email address and try again.'],
    [429, 'Too many requests. Please wait a minute and try again.'],
    [500, "We couldn't save your request. Please try again."],
    [503, "We couldn't save your request. Please try again."],
  ])(
    'shows a safe inline error for HTTP %s and leaves the email available to retry',
    async (code, message) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('untrusted response text', { status: code })),
      )
      const { status, email, form } = await submit()
      expect(status.dataset.state).toBe('error')
      expect(status.getAttribute('role')).toBe('alert')
      expect(status.textContent).toBe(message)
      expect(email.value).toBe('visitor@example.com')
      expect(email.getAttribute('aria-invalid')).toBe(code === 400 ? 'true' : null)
      expect(email.getAttribute('aria-describedby')).toBe(`cloud-consent ${status.id}`)
      expect(getForm(1).email.getAttribute('aria-describedby')).toBe('pricing-consent')
      expect(document.activeElement).toBe(status)
      expect(form.hasAttribute('aria-busy')).toBe(false)
    },
  )

  it('recovers from a network failure without rendering the exception text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('visitor@example.com')))
    const { status, email } = await submit()
    expect(status.dataset.state).toBe('error')
    expect(status.getAttribute('role')).toBe('alert')
    expect(status.textContent).toBe("We couldn't save your request. Please try again.")
    expect(email.value).toBe('visitor@example.com')
    expect(email.getAttribute('aria-describedby')).toBe(`cloud-consent ${status.id}`)
  })

  it('clears validation errors on a successful retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { email, status } = await submit()
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(email.getAttribute('aria-describedby')).toBe(`cloud-consent ${status.id}`)
    await submit()
    expect(email.hasAttribute('aria-invalid')).toBe(false)
    expect(email.getAttribute('aria-describedby')).toBe('cloud-consent')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.dataset.state).toBe('success')
  })

  it('removes the previous error association while retrying and keeps the consent note', async () => {
    let complete: (response: Response) => void = () => {}
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { form, email, status, button } = await submit()
    expect(email.getAttribute('aria-describedby')).toBe(`cloud-consent ${status.id}`)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(button.disabled).toBe(true)
    expect(status.dataset.state).toBe('pending')
    expect(email.getAttribute('aria-describedby')).toBe('cloud-consent')
    complete(new Response('{}', { status: 200 }))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(email.getAttribute('aria-describedby')).toBe('cloud-consent')
  })
})

describe('waitlist CTA focus', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <a href="#cloud-waitlist" data-waitlist-link>Join the Cloud waitlist</a>
      <a href="#missing-waitlist" data-waitlist-link>Unavailable form</a>
      ${formMarkup('cloud')}`
    setupWaitlistForms(document)
  })

  it('focuses the email when a native link click is activated, including keyboard activation', () => {
    const link = document.querySelector<HTMLAnchorElement>('a[data-waitlist-link]')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link?.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(getForm().email)
  })

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])(
    'preserves browser navigation for a modified click with %s',
    (modifier) => {
      const link = document.querySelector<HTMLAnchorElement>('a[data-waitlist-link]')
      const click = new MouseEvent('click', { cancelable: true, [modifier]: true })
      link?.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(false)
      expect(document.activeElement).not.toBe(getForm().email)
    },
  )

  it('leaves the native hash fallback available when a form is missing', () => {
    const link = document.querySelectorAll<HTMLAnchorElement>('a[data-waitlist-link]')[1]
    const click = new MouseEvent('click', { cancelable: true })
    link?.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })
})

describe('waitlist page integration', () => {
  const component = read('./components/WaitlistForm.astro')
  const home = read('./pages/index.astro')

  it('offers the form in the Cloud, pricing and Cloud availability FAQ sections', () => {
    expect(home).toMatch(/<WaitlistForm source="cloud"/)
    expect(home).toMatch(/<WaitlistForm source="pricing"/)
    expect(home).toMatch(
      /When will Hourmere Cloud be available\?[\s\S]*?invitation-only preview[\s\S]*?<WaitlistForm source="faq"/,
    )
  })

  it('keeps a native POST form with a labelled single-email input and English metadata', () => {
    expect(component).toMatch(/<form action="\/api\/waitlist" method="post"/)
    expect(component).toMatch(/<label for=\{`\$\{id\}-email`\}>Email address<\/label>/)
    expect(component).toMatch(/id=\{`\$\{id\}-email`\}[\s\S]*?name="email"[\s\S]*?type="email"/)
    expect(component).toMatch(/autocomplete="email"[\s\S]*?maxlength="254"[\s\S]*?required/)
    expect(component).toMatch(/aria-describedby=\{`\$\{id\}-consent`\}/)
    expect(component).toContain('<input name="source" type="hidden" value={source} />')
    expect(component).toContain('<input name="locale" type="hidden" value="en" />')
    expect(read('./layouts/Base.astro')).toContain('<html lang="en">')
    expect(read('../astro.config.ts')).not.toMatch(/\bi18n\s*:/)
  })

  it('puts the consent and privacy link beside every form and exposes feedback accessibly', () => {
    expect(component).toContain(
      'We\'ll email you when Hourmere Cloud launches. See our <a href="/privacy">privacy policy</a>.',
    )
    expect(component).toMatch(/role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"/)
    expect(component).toContain('tabindex="-1"')
  })

  it('keeps the honeypot hidden and out of keyboard navigation with an autofill-neutral name', () => {
    expect(component).toMatch(/<label for=\{`\$\{id\}-hm-extra`\}>Leave this field empty<\/label>/)
    const honeypot = component.match(/<input\s+id=\{`\$\{id\}-hm-extra`\}[^>]*>/)?.[0] ?? ''
    expect(honeypot).toContain('name="hm_extra"')
    expect(honeypot).toContain('autocomplete="off"')
    expect(honeypot).toContain('tabindex="-1"')
    expect(component).toContain('class="waitlist-trap" aria-hidden="true"')
    expect(component).toMatch(
      /\.waitlist-trap\s*\{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip-path: inset\(50%\)/,
    )
  })

  it('deploys the pinned Wrangler version to the top-level environment explicitly', () => {
    const config = JSON.parse(read('../package.json'))
    expect(config.scripts.deploy).toBe(
      'npm run build && npx --yes wrangler@4.151.0 deploy --env=""',
    )
  })

  it('reveals the no-JavaScript success state only at its dedicated redirect target', () => {
    expect(component).toContain("source === 'cloud' ? 'cloud-waitlist-success'")
    expect(component).toMatch(/\.waitlist \.waitlist-status\s*\{\s*visibility: hidden/)
    expect(component).toMatch(/\.waitlist-status:target,[\s\S]*?visibility: visible/)
    expect(component).toContain("source === 'cloud' ? waitlistMessages.success : ''")
    expect(component).toContain('id={id}')
  })
})

describe('waitlist layout protections', () => {
  const component = read('./components/WaitlistForm.astro')
  const home = read('./pages/index.astro')
  const declarations = (source: string, selector: string, media?: string) => {
    const result: Record<string, string> = {}
    postcss.parse(source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '').walkRules((rule) => {
      const context = rule.parent?.type === 'atrule' ? (rule.parent as AtRule).params : undefined
      if (
        rule.selector
          .split(',')
          .map((part) => part.trim())
          .includes(selector) &&
        context === media
      ) {
        rule.walkDecls((declaration) => {
          result[declaration.prop] = declaration.value
        })
      }
    })
    return result
  }

  it('replaces all four launch-update mailto CTAs and preserves the general contact link', () => {
    const links = [...home.matchAll(/<a\s+[^>]*data-waitlist-link[^>]*>/g)].map((match) => match[0])
    expect(links).toHaveLength(4)
    for (const link of links) expect(link).toContain('href="#cloud-waitlist"')
    expect(home).not.toContain('launchUpdatesHref')
    expect(home).toMatch(/href=\{`mailto:\$\{contact\.hello\}`\}/)
    expect(home).not.toContain('Cloud has not launched')
    expect(home.match(/Sign-ups are currently closed\./g)).toHaveLength(3)
    expect(home).toContain('Hourmere 1.0.0 was released for self-hosting on November 30, 2026.')
  })

  it('reserves every possible status at its actual wrapped height before any request starts', () => {
    expect(component).toContain('class="waitlist-feedback-space" aria-hidden="true"')
    expect(component).toContain(
      'Object.values(waitlistMessages).map((message) => <span>{message}</span>)',
    )
    expect(Object.values(waitlistMessages)).toHaveLength(5)
    for (const selector of ['.waitlist-feedback', '.waitlist-feedback-space']) {
      expect(declarations(component, selector).display).toBe('grid')
    }
    for (const selector of [
      '.waitlist-feedback-space',
      '.waitlist-feedback-space span',
      '.waitlist .waitlist-status',
    ]) {
      expect(declarations(component, selector)['grid-area']).toBe('1 / 1')
    }
    expect(declarations(component, '.waitlist-feedback-space').visibility).toBe('hidden')
    expect(declarations(component, '.waitlist .waitlist-status').visibility).toBe('hidden')
    expect(declarations(component, '.waitlist .waitlist-status').display).toBeUndefined()
    expect(declarations(component, '.waitlist-status[data-state]').visibility).toBe('visible')
    expect(declarations(component, '.waitlist-status:target').visibility).toBe('visible')
  })

  it('changes only the invalid input border color without increasing its size', () => {
    expect(declarations(component, 'input[type="email"]').border).toBe('2px solid var(--muted)')
    const invalid = declarations(component, 'input[aria-invalid="true"]')
    expect(invalid['border-color']).toBe('var(--text)')
    expect(invalid['border-width']).toBeUndefined()
    expect(invalid.border).toBeUndefined()
  })

  it('keeps the form fluid and gives touch users at least 44px input, button and link targets', () => {
    expect(declarations(component, '.waitlist-fields')).toMatchObject({
      display: 'flex',
      'flex-wrap': 'wrap',
    })
    expect(declarations(component, 'input[type="email"]')).toMatchObject({
      width: '100%',
      'min-width': '0',
      'min-height': '46px',
    })
    expect(read('./styles/global.css')).toMatch(/\.btn\s*\{[^}]*min-height: 46px/)
    for (const [source, selector] of [
      [component, '.waitlist-consent a'],
      [home, 'a[data-waitlist-link]'],
    ]) {
      expect(declarations(source ?? '', selector ?? '', '(pointer: coarse)')).toMatchObject({
        display: 'inline-flex',
        'min-height': '44px',
      })
    }
  })

  it('uses the site dark-mode palette for the input and feedback', () => {
    expect(declarations(component, 'input[type="email"]')).toMatchObject({
      background: 'var(--bg)',
      color: 'var(--text)',
    })
    expect(declarations(component, '.waitlist-feedback').color).toBe('var(--text)')
  })
})
