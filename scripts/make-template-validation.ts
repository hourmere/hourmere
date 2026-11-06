type Document = { paths: Record<string, Record<string, unknown>> }
type Recipe = {
  format: string
  id: string
  title: string
  webhookEvents: string[]
  requests: { method: string; path: string }[]
  connections: { kind: string; purpose: string }[]
  settings: { documentation: string; apiKeyScope: string; signatureVerification: string }
}

/** Offline recipe metadata, deliberately not a Make blueprint or credential container. */
export function validateMakeRecipe(value: unknown, document: Document, events: readonly string[]) {
  const errors: string[] = []
  const raw = JSON.stringify(value)
  // Do not include offending values in diagnostics: this check also runs in CI.
  if (/hm_|whsec_|Bearer\s+(?!\{\{)[A-Za-z0-9]/i.test(raw)) errors.push('embedded credential')
  const placeholder = /^\{\{[A-Z][A-Z0-9_]*\}\}$/
  function inspect(item: unknown, key = '') {
    if (typeof item === 'string') {
      if (
        /secret|password|token|authorization|api[-_]?key$/i.test(key) &&
        !placeholder.test(item)
      ) {
        errors.push('credential field must be a placeholder')
      }
      for (const match of item.matchAll(/https?:\/\/[^\s"<>]+/gi)) {
        const url = new URL(match[0])
        if (
          !/^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/.test(url.hostname) ||
          url.username ||
          url.password
        ) {
          errors.push('non-placeholder URL')
        }
      }
    } else if (Array.isArray(item)) {
      for (const child of item) inspect(child, key)
    } else if (item && typeof item === 'object') {
      for (const [childKey, child] of Object.entries(item)) inspect(child, childKey)
    }
  }
  inspect(value)
  const recipe = value as Recipe
  if (
    recipe?.format !== 'hourmere.make.manual-recipe.v1' ||
    typeof recipe.id !== 'string' ||
    typeof recipe.title !== 'string' ||
    !Array.isArray(recipe.webhookEvents) ||
    !Array.isArray(recipe.requests) ||
    !Array.isArray(recipe.connections) ||
    !recipe.settings ||
    typeof recipe.settings.documentation !== 'string'
  )
    return [...errors, 'invalid manual recipe shape']
  if (recipe.requests.length === 0) errors.push('missing REST references')
  for (const request of recipe.requests) {
    if (
      typeof request?.path !== 'string' ||
      typeof request.method !== 'string' ||
      !Object.hasOwn(document.paths[request.path] ?? {}, request.method.toLowerCase())
    ) {
      errors.push('unknown REST method/path')
    }
  }
  for (const event of recipe.webhookEvents) {
    if (!events.includes(event)) errors.push('unknown webhook event')
  }
  errors.push(...validateMakeReferences(raw, document, events))
  return errors
}

/** Validate API and event references in both metadata and the actual module instructions. */
export function validateMakeReferences(raw: string, document: Document, events: readonly string[]) {
  const errors: string[] = []
  for (const match of raw.matchAll(/(?<![A-Za-z0-9_.-])booking\.[a-z_]+/g)) {
    if (!events.includes(match[0])) errors.push('unknown inline webhook event')
  }
  for (const match of raw.matchAll(/\/api\/v1\/[A-Za-z0-9_/{}/-]+/g)) {
    if (!Object.hasOwn(document.paths, match[0])) errors.push('unknown inline REST path')
  }
  return errors
}

export function validateMakeInventory(names: string[]) {
  const required = [
    'booking-created-sheets.recipe.json',
    'booking-cancelled-slack.recipe.json',
    'find-slots-create-booking.recipe.json',
  ]
  return required.filter((name) => !names.includes(name))
}
