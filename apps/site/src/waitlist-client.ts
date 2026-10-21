export const waitlistMessages = {
  success: "Thanks. We'll email you when Hourmere Cloud launches.",
  pending: 'Joining the waitlist…',
  invalid: 'Enter one valid email address and try again.',
  rateLimited: 'Too many requests. Please wait a minute and try again.',
  unavailable: "We couldn't save your request. Please try again.",
} as const

export function setupWaitlistForms(document: Document) {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-waitlist-link]')) {
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }
      const email = document
        .getElementById(link.hash.slice(1))
        ?.querySelector<HTMLInputElement>('input[name="email"]')
      if (!email) return
      event.preventDefault()
      email.focus()
    })
  }

  for (const form of document.querySelectorAll<HTMLFormElement>('[data-waitlist-form]')) {
    const status = form.querySelector<HTMLElement>('[data-waitlist-status]')
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')
    if (!status || !button || !email) continue
    const consentDescription = email.getAttribute('aria-describedby') ?? ''

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (button.disabled) return
      button.disabled = true
      form.setAttribute('aria-busy', 'true')
      email.removeAttribute('aria-invalid')
      email.setAttribute('aria-describedby', consentDescription)
      status.dataset.state = 'pending'
      status.setAttribute('role', 'status')
      status.textContent = waitlistMessages.pending

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new FormData(form),
        })
        if (response.ok) {
          status.dataset.state = 'success'
          status.textContent = waitlistMessages.success
          form.reset()
        } else {
          status.dataset.state = 'error'
          status.setAttribute('role', 'alert')
          if (response.status === 400) {
            status.textContent = waitlistMessages.invalid
            email.setAttribute('aria-invalid', 'true')
          } else if (response.status === 429) {
            status.textContent = waitlistMessages.rateLimited
          } else {
            status.textContent = waitlistMessages.unavailable
          }
        }
      } catch {
        status.dataset.state = 'error'
        status.setAttribute('role', 'alert')
        status.textContent = waitlistMessages.unavailable
      } finally {
        if (status.dataset.state === 'error') {
          email.setAttribute(
            'aria-describedby',
            [consentDescription, status.id].filter(Boolean).join(' '),
          )
        }
        button.disabled = false
        form.removeAttribute('aria-busy')
        status.focus()
      }
    })
  }
}
