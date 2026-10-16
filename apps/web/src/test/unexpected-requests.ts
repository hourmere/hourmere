// Requests the fake API had no route for. The app shows network errors gracefully, so a test
// would not notice them; setup.ts fails the test instead. (Its own module: setup.ts must not
// import the app, or test files could no longer mock the app's modules.)
const unexpected: string[] = []

export function recordUnexpectedRequest(request: string) {
  unexpected.push(request)
}

/** Returns (and forgets) the requests recorded since the last call. */
export function takeUnexpectedRequests(): string[] {
  return unexpected.splice(0)
}
