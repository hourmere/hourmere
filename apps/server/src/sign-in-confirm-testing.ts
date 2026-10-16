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
  runInNewContext(script, {
    location: { hash: link.hash },
    URLSearchParams,
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => ({}),
    },
  })
  if (elements.confirm?.hidden) throw new Error('the confirm page shows no button for this link')

  // A GET form submission: the form's fields become the action's query string.
  const url = new URL(form, link.origin)
  for (const { type, name, value } of inputs) {
    if (type !== 'hidden' || !name || value === undefined) throw new Error('unexpected input')
    url.searchParams.append(name, value)
  }
  return url
}
