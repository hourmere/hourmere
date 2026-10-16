/** Leaves the app for another page, e.g. a sign-in provider's. (A module so tests can stub it.) */
export function goTo(url: string) {
  window.location.assign(url)
}
