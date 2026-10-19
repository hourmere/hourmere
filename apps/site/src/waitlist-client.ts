const successMessage = "Thanks. We'll email you when Hourmere Cloud launches."

export function setupWaitlistForms(document: Document) {
  for (const form of document.querySelectorAll<HTMLFormElement>('[data-waitlist-form]')) {
    const status = form.querySelector<HTMLElement>('[data-waitlist-status]')
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')
    if (!status || !button || !email) continue

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (button.disabled) return
      button.disabled = true
      form.setAttribute('aria-busy', 'true')
      email.removeAttribute('aria-invalid')
      status.dataset.state = 'pending'
      status.setAttribute('role', 'status')
      status.textContent = 'Joining the waitlist…'

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new FormData(form),
        })
        if (response.ok) {
          status.dataset.state = 'success'
          status.textContent = successMessage
          form.reset()
        } else {
          status.dataset.state = 'error'
          status.setAttribute('role', 'alert')
          if (response.status === 400) {
            status.textContent = 'Enter one valid email address and try again.'
            email.setAttribute('aria-invalid', 'true')
          } else if (response.status === 429) {
            status.textContent = 'Too many requests. Please wait a minute and try again.'
          } else {
            status.textContent = "We couldn't save your request. Please try again."
          }
        }
      } catch {
        status.dataset.state = 'error'
        status.setAttribute('role', 'alert')
        status.textContent = "We couldn't save your request. Please try again."
      } finally {
        button.disabled = false
        form.removeAttribute('aria-busy')
        status.focus()
      }
    })
  }
}
