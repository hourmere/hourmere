import type { ComponentType, LazyExoticComponent } from 'react'

/** React.lazy's own fields: `_init(_payload)` returns the component, or throws its pending load. */
interface LazyInternals {
  _payload: unknown
  _init: (payload: unknown) => unknown
}

/**
 * Loads route chunks (React.lazy components) before a test renders them, as a page visited
 * earlier would have. Rendering a chunk for the first time suspends, and React then holds
 * the page back for up to 300 ms per suspended boundary (its fallback throttle), outside
 * act(). A file's first test would otherwise spend most of a 1 s findBy* on that, and time
 * out under CI load before its page had finished loading.
 */
export async function resolveLazy(...components: LazyExoticComponent<ComponentType>[]) {
  for (const component of components) {
    const { _payload, _init } = component as unknown as LazyInternals
    if (typeof _init !== 'function') throw new Error('Not a React.lazy component')
    try {
      _init(_payload)
    } catch (pending) {
      await pending
    }
    // Throws if the chunk failed to load, so the test fails here and not in a later wait.
    _init(_payload)
  }
}
