# Zoom connections

Zoom account connections are independent from Hourmere sign-in and calendar connections.
The [Zoom account setup guide](../apps/site/src/content/docs/docs/zoom-connections.md) covers
client configuration, identity-only permissions, reconnect and disconnect. For explicitly
authorized single-host meetings, see [automatic Zoom](automatic-zoom.md).

## Refresh and abandoned operations

The Conference accounts page offers **Refresh Zoom account** for both `active` and
`refreshing` connections. An owner-scoped operation lease serializes Zoom token changes,
including changes for different Zoom identities belonging to that Hourmere user.

If an operation still owns a live lease, explicit refresh returns HTTP 409:

```json
{
  "error": "zoom_refresh_in_progress",
  "errorAlias": "zoom_operation_busy",
  "message": "Zoom account operations are busy. Try again shortly."
}
```

New clients should prefer the neutral `errorAlias` and accept `zoom_refresh_in_progress`
when talking to older servers. The legacy code is deprecated for one release and remains
in `/api/v1` for compatibility. The conflict means an owner operation is busy; it does not
identify which connection or operation holds the lease. Wait briefly before retrying.

A refresh that acquires a valid lease and still finds `refreshing` can prove that the old
rotation was abandoned. It changes the connection to `needs_reauth`, clears the old
operation and credentials, and returns `zoom_needs_reauth` without calling Zoom. The page
then tells the user to choose **Reconnect Zoom**. This explicit path also recovers
identity-only connections, which have no meeting worker to discover the abandoned refresh.

## Callback replay and busy

`GET /api/conference/zoom/callback` returns to `/app/conferences` with a fixed result code.
For a syntactically valid state, it tries to acquire the owner's token-operation lease
before inspecting the OAuth attempt. An occupied lease returns `busy` immediately; that
request neither consumes state nor exchanges a provider code.

The result describes lease contention, not the state of the submitted attempt:

| Submitted attempt | While the owner's lease is occupied | After the lease is released |
| --- | --- | --- |
| Unclaimed, unexpired, same-session state with a valid provider code | `busy`, with the attempt unchanged | Can complete normally |
| Already claimed by an exchange still in progress | `busy`, without a second exchange | `invalid_state`, without a second exchange |
| Already completed or otherwise invalid state with valid syntax | `busy`, without another exchange | `invalid_state`, without another exchange |

In particular, replaying the same callback while its first exchange is in progress returns
`busy`, rather than `invalid_state`. The same can happen when a different exchange for that
owner holds the lease. A `busy` result is not evidence that a state or provider code remains
valid or reusable. State claims are durable, single-use and session-bound; they clear the
stored PKCE verifier before provider I/O. Completion, failure or a failed final commit does
not make a claimed attempt reusable. Expiry is checked when claiming; an exchange claimed
before expiry may finish successfully after expiry.

The browser offers a neutral retry message and the user can start **Connect Zoom** or
**Reconnect Zoom** again after the busy operation finishes. The original callback can only
succeed on retry if its state was never claimed, its session and attempt remain valid, and
the provider code is still valid. Do not automatically replay a claimed callback or infer
successful authorization from `busy`.
