# Website and Hourmere Cloud waitlist

`apps/site` is the English-only Astro website. On November 30, 2026, Hourmere
launches as open-source software for self-hosting; Hourmere Cloud opens a waitlist,
not a hosted account signup. The waitlist sends no email yet. Any later launch
email must include a way to opt out and use the list only for its stated purpose.

The Worker handles only `POST /api/waitlist`; every other request goes to `ASSETS`.
The static asset configuration retains `auto-trailing-slash`, the custom 404 page,
and `public/_headers`. The website is separate from the product server and its
PostgreSQL schema/OpenAPI API. D1 has its own numbered SQL migrations under
`apps/site/migrations`; no PostgreSQL table types are added for it.

## Request and storage contract

JSON, URL-encoded and multipart/form-data submissions accept exactly one `email`,
an optional `hm_extra` honeypot, optional `locale` (`en`), and optional `source`
(`cloud`, `pricing`, or `faq`). The email is trimmed, lowercased, bounded to 254 characters,
and checked as one ordinary email address. Unknown fields, repeated form fields,
and malformed values are rejected. The server records consent text version
`2026-11-30`, joining time, source and locale. Duplicate inserts preserve the
original record; their success response is identical to a first submission.
A filled honeypot returns that same success without storing anything.
The site's JavaScript sends multipart/form-data; the native form without
JavaScript sends URL-encoded data.

`Origin` is mandatory: only `https://hourmere.com` and
`https://www.hourmere.com` are accepted in production. Loopback development is
enabled only by the separate `development` environment and a loopback request URL.
The form's successful non-JavaScript submission uses a 303 status redirect;
validation/rate-limit errors retain HTTP 400/429 and show a safe HTML explanation
and return link. Fetch clients get JSON and inline feedback. Responses never
echo submitted input and use `Cache-Control: no-store`.

The native `WAITLIST_RATE_LIMITER` binding allows 5 attempts per 60 seconds per
client IP. No IP column, application log or persistent IP map is created. The
limiter receives a stable SHA-256 key rather than the raw address; the binding
controls the 60-second period, so crossing a clock-minute boundary does not change
the key. Missing production client IPs or unavailable dependencies fail closed. Cloudflare's
[rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is approximate and local to a Cloudflare location; it is not a global quota.
Wrangler 4.151.0 supports the `ratelimits` configuration used here.

## Local validation only

From the repository root:

```sh
npm run build --workspace @hourmere/site
npm run test:smoke --workspace @hourmere/site
```

The smoke script starts `npx --yes wrangler@4.151.0 dev --local` with the
`development` environment, an unused loopback port and temporary local D1 state.
It compares five routes against the built HTML bytes, including the custom 404,
checks response headers and canonical redirects, then tests JSON, URL-encoded and multipart POST,
duplicate insertion, honeypot suppression and schema preservation/fresh/no-op
migration. It stops its own processes and removes its own temporary state.
No Cloudflare resources are created and no deployment occurs.

For interactive local development (run from `apps/site`):

```sh
npx --yes wrangler@4.151.0 d1 migrations apply WAITLIST_DB --local --env development
npx --yes wrangler@4.151.0 dev --local --env development --port 8787
```

Astro's normal `dev` command serves the UI only; use Wrangler for real form POSTs.

## Lead configuration before deployment

Only after acceptance and owner approval, in the Cobaltmere Cloudflare account:

1. Create the D1 database named **`hourmere-cloud-waitlist`** in the United States,
   matching privacy policy section 12. From `apps/site`, run:

   ```sh
   npx --yes wrangler@4.151.0 d1 create hourmere-cloud-waitlist --jurisdiction us
   ```

   Do not use `--update-config`: it can rewrite the existing binding configuration.
   Replace
   `TODO_CREATE_WAITLIST_D1_DATABASE` in the production `d1_databases` entry with
   the returned ID; keep the **`WAITLIST_DB`** binding and `migrations_dir`.
   The development entry is local-only and retains its placeholder.
2. Choose an unused account-unique numeric rate-limit namespace ID, replacing
   the production placeholder namespace `1001`. Keep the
   **`WAITLIST_RATE_LIMITER`** binding and its `simple` limit 5, period 60.
   This is configured by the Worker binding; no KV, Durable Object or Turnstile
   resource/key is required. Never enable `WAITLIST_DEVELOPMENT` in production.
3. Apply the remote migration from `apps/site`:

   ```sh
   npx --yes wrangler@4.151.0 d1 migrations apply WAITLIST_DB --remote --env=""
   ```

4. Confirm the existing custom-domain routes **`hourmere.com`** and
   **`www.hourmere.com`**, and the **`ASSETS`** binding with API worker-first
   routing in `wrangler.jsonc`. The account must control the domains/DNS.
   `workers_dev` and preview URLs remain disabled.
5. The lead can then run `npm run deploy --workspace @hourmere/site` from the
   repository root and verify both domains. This task does not run that command.

See Cloudflare's [D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/)
for account-side operations. Keep remote operations separate from local checks.

## Export and deletion administration

Run from `apps/site` as an authorized operator. Export only to a protected file
outside the repository; do not attach lists or addresses to issues or logs:

```sh
umask 077
npx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" --json \
  --command 'SELECT email, created_at, source, locale, consent_text_version FROM waitlist ORDER BY created_at' \
  > /secure/operator-owned-directory/waitlist.json
```

For an individual deletion/withdrawal request sent to `privacy@cobaltmere.com`,
verify the request through the privacy process, normalize the address, then
prepare a private SQL file outside the repository. Use a SQL string literal
(double any embedded single quote); never interpolate untrusted shell text.
For example, the private file's contents for a synthetic address are:

```sql
DELETE FROM waitlist WHERE email = 'person@example.test';
```

```sh
npx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" \
  --file /secure/operator-owned-directory/delete-waitlist.sql
```

Remove the address from any outstanding launch-mail export/queue too, and delete
operator-created files when finished. A subsequent new form submission expresses
new consent. This implementation has no other email delivery integration and
makes no numeric retention promise.

After the Hourmere Cloud launch notification has been sent, delete the list,
matching the privacy policy's retention limit of until withdrawal or the launch
notification. From `apps/site`, run:

```sh
npx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" \
  --command 'DELETE FROM waitlist;'
```

Delete any launch-mail exports and queued copies as well.
