// Test support: what a browser does with an emailed sign-in link.
import { runInNewContext } from 'node:vm'

interface App {
  request(input: string): Response | Promise<Response>
}

/**
 * Opens the confirm page an emailed link leads to (the fragment stays in the browser), runs
 * the page's script against a minimal DOM, and returns the URL that pressing its button
 * requests. Throws if the page shows no button or submits on its own.
 */
export async function pressConfirmButton(app: App, link: URL): Promise<URL> {
  const res = await app.request(`${link.origin}${link.pathname}`)
  if (res.status !== 200) throw new Error(`confirm page answered ${res.status}`)
  const html = await res.text()
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  const form = /<form id="confirm" method="get" action="([^"]+)"/.exec(html)?.[1]
  if (!script || !form) throw new Error('confirm page has no script or no GET form')

  const inputs: { type?: string; name?: string; value?: string }[] = []
  const elements: Record<string, { hidden: boolean } & Record<string, unknown>> = {
    confirm: {
      hidden: true,
      append: (input: (typeof inputs)[number]) => void inputs.push(input),
      submit: () => {
        throw new Error('the confirm page submitted on its own')
      },
      requestSubmit: () => {
        throw new Error('the confirm page submitted on its own')
      },
    },
    incomplete: { hidden: true },
  }
  // The page may read the fragment and nothing else of its location, and must not navigate
  // (href, assign, replace, reload): only the button may lead to Better Auth.
  const location = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === 'hash') return link.hash
        throw new Error(`the confirm page used location.${String(prop)}`)
      },
      set: (_, prop) => {
        throw new Error(`the confirm page navigated (location.${String(prop)})`)
      },
      defineProperty: () => {
        throw new Error('the confirm page changed its location')
      },
    },
  )
  const document = new Proxy(
    {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => ({}),
    },
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as keyof typeof target]
        throw new Error(`the confirm page used document.${String(prop)}`)
      },
      set: (_, prop) => {
        throw new Error(`the confirm page set document.${String(prop)}`)
      },
    },
  )
  const context = { URLSearchParams, document }
  // `location = url` navigates too.
  Object.defineProperty(context, 'location', {
    get: () => location,
    set: () => {
      throw new Error('the confirm page navigated (location)')
    },
  })
  runInNewContext(script, context)
  if (elements.confirm?.hidden) throw new Error('the confirm page shows no button for this link')

  // A GET form submission: the form's fields become the action's query string.
  const url = new URL(form, link.origin)
  for (const { type, name, value } of inputs) {
    if (type !== 'hidden' || !name || value === undefined) throw new Error('unexpected input')
    url.searchParams.append(name, value)
  }
  return url
}
