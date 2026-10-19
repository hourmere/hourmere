// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupWaitlistForms } from './waitlist-client'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const formMarkup = (id: string) => `
  <form action="/api/waitlist" method="post" data-waitlist-form>
    <input name="email" type="email" value="" />
    <input name="website" value="" />
    <input name="locale" value="en" />
    <input name="source" value="${id}" />
    <button type="submit">Join the Cloud waitlist</button>
    <p tabindex="-1" role="status" data-waitlist-status></p>
  </form>`

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
      ['website', ''],
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
  })

  it('clears validation errors on a successful retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { email, status } = await submit()
    expect(email.getAttribute('aria-invalid')).toBe('true')
    await submit()
    expect(email.hasAttribute('aria-invalid')).toBe(false)
    expect(status.getAttribute('role')).toBe('status')
    expect(status.dataset.state).toBe('success')
  })
})

describe('waitlist page integration', () => {
  const component = read('./components/WaitlistForm.astro')
  const home = read('./pages/index.astro')

  it('offers the form in the Cloud, pricing and Cloud availability FAQ sections', () => {
    expect(home).toMatch(/<WaitlistForm source="cloud"/)
    expect(home).toMatch(/<WaitlistForm source="pricing"/)
    expect(home).toMatch(
      /When will Hourmere Cloud be available\?[\s\S]*?Hourmere Cloud has not launched\.[\s\S]*?<WaitlistForm source="faq"/,
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
    expect(component).toMatch(/name="website"[\s\S]*?tabindex="-1"[\s\S]*?autocomplete="off"/)
    expect(component).toContain('class="waitlist-trap" aria-hidden="true"')
  })

  it('reveals the no-JavaScript success state only at its dedicated redirect target', () => {
    expect(component).toContain("source === 'cloud' ? 'cloud-waitlist-success'")
    expect(component).toMatch(/\.waitlist \.waitlist-status\s*\{\s*display: none/)
    expect(component).toMatch(/\.waitlist-status:target,[\s\S]*?display: block/)
    expect(component).toContain("Thanks. We'll email you when Hourmere Cloud launches.")
    expect(component).toContain('id={id}')
  })
})
