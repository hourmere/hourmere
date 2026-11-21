/** Leaves the app for another page, e.g. a sign-in provider's. (A module so tests can stub it.) */
export function goTo(url: string) {
  window.location.assign(url)
}

/** Leaves a spent confirmation out of the back history. */
export function replaceWith(url: string) {
  window.location.replace(url)
}

export function reloadPage() {
  window.location.reload()
}
