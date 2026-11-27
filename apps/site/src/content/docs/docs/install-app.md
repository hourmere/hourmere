---
title: Install the app
description: Install Hourmere, understand its offline behavior, and read the Web Push feasibility and privacy assessment.
---

Open your Hourmere instance over HTTPS, sign in, and visit an account page under
`/app/`. You can install that account interface on supported phones and desktop
browsers. Installation is optional: the same features remain available in your browser.
The public booking pages do not offer installation of the account app.

## iPhone and iPad

Check your sign-in method before installing. iOS home-screen web apps keep cookies
separate from Safari. Email sign-in links open in Safari, so completing one there does
not sign you in inside the installed app.

For a standalone app, use a sign-in method that completes inside the app, such as a
configured Google or Microsoft sign-in flow, and check that it returns to the app on your
device. If you rely on email-link sign-in, keep using Hourmere in Safari. If your device
offers **Open as Web App**, turn it off when adding a Safari shortcut for this purpose.

To install after checking sign-in, open Safari's Share menu, choose **Add to Home Screen**,
and confirm **Add**. Open the new Hourmere icon and verify that sign-in works there before
relying on the installed app.

## Android

In Chrome, open the browser menu and choose **Install app** or **Add to Home screen**,
then follow the confirmation. The wording depends on your browser and Android version.
If the option is unavailable, make sure you are on an account page, online, using HTTPS.

## Desktop

In Chrome or Edge, use the install icon in the address bar or the browser menu's install
option. Safari versions that support web apps offer **File → Add to Dock**. Availability
and wording vary by browser; browsers without installation support can use Hourmere
normally in a tab.

## Offline behavior and privacy

After an online visit has prepared the app, opening an account page without a connection
shows an offline notice in English and Simplified Chinese after a full reload or reopening
the app. Navigation within an already open page can still show data held in memory; that
is not data stored in the offline cache. Reconnect and reload to continue.
There is no offline booking, calendar, event editing or account-data view. Unsaved work
is not queued for later submission. Installation does not add push notifications or
background calendar synchronization on your device.

The small, hand-written service worker needs no additional runtime library. Its build-generated
allowlist keeps the offline policy explicit and auditable. It stores only public, static application files: the entry HTML,
versioned JavaScript and CSS, icons, fonts and the offline notice. It never stores API or
authentication responses, booking management links, embedded booking endpoints, MCP or
OAuth responses, or responses marked `no-store` or `private`. Signing out does not leave
account data in this offline cache. Browser cookies and your existing language/time-zone
preferences still follow the normal account and [interface-language](/docs/interface-languages)
behavior; installing the app does not turn them into an offline account store.

The installed app and its service worker are scoped to `/app/` on your instance's own
origin. Public booking, private management links and sign-in pages remain outside that
scope. This keeps invitees from being offered installation of their host's account app.
Public booking pages need a connection and do not gain an offline fallback.

## Updates and self-hosting

Online page navigation fetches the current entry page from the server. A newly downloaded
worker reuses unchanged hashed JavaScript and CSS files by URL, fetches changed assets
and unversioned shell files, then removes old app-shell caches after activation. Reconnect and
reload an already open tab to pick up the latest interface. If the browser has removed
site storage, the offline notice is available again after a successful online visit.

The [documented reverse proxy](/docs/self-hosting) supports installation without a cloud
service or additional subscription. Keep the application at the origin root, serve
`/app/sw.js` as JavaScript and `/app/manifest.webmanifest` as a web app manifest, and retain
the server's security and cache headers. The worker lives in `/app/`, so its default
maximum scope already covers the app; no broader `Service-Worker-Allowed` header is needed.
Do not broaden its scope to `/` or have the proxy cache private responses. HTTPS is required
except for local development on localhost.

Development builds do not register a service worker. To turn PWA support off, set
`VITE_PWA_ENABLED=false` in the repository-root `.env`, rebuild and redeploy. The
[self-hosting instructions](/docs/self-hosting#turn-off-app-installation) cover Compose,
direct web builds and Docker build arguments. An empty or omitted value uses the current
default (`true`); explicit `true` and `false` are accepted, and other values fail the build.
Changing only the running container's environment cannot change an already-built app.
Prebuilt image installs have no runtime off switch and must convert to a source build
as described in those instructions; the image overlay ignores locally tagged replacements.

The disabled build stops registering workers and still serves `/app/sw.js` as a minimal
retirement worker. When an existing browser next checks for an update online, it activates
that worker, deletes Hourmere's app-shell caches, and unregisters itself. It does not
intercept requests or force a page reload. Offline clients cannot receive this change until
they reconnect, and browser update timing varies. Keep serving the retirement worker so
clients returning later can receive it; do not replace it with a 404. An already open page
may remain controlled until it closes or reloads. Cookies and account data are not deleted.

The home-screen or desktop icon remains installed. To remove the installed app itself,
use your browser or operating system's uninstall option.

## Web Push assessment

**Current availability.** Hourmere does not send Web Push notifications or request
notification permission. The following is a proposal for future work. Existing
[booking email and reminders](/docs/notifications) are available independently of app installation.

**Recommendation.** Pilot one optional, generic reminder for signed-in hosts with an
upcoming confirmed booking. Keep delivery off until the operator has configured it and
the host has enabled it on that browser profile or app install. Keep booking email
independent of push delivery and permission. Start with standards-based Web Push through
the existing `/app/` service worker and use the same implementation for self-hosting,
without a paid-plan requirement. Decide separately whether to build a native app.

### Browser support

| Platform | What the proposed pilot could support |
| --- | --- |
| Desktop Chrome, Edge and Firefox | The Push API is available in current desktop versions. A signed-in account tab can subscribe without installing the app. |
| Android Chrome and Firefox | The Push API is available in current versions. An HTTPS browser tab can subscribe without installing the app. |
| macOS Safari | Standards-based Web Push shipped with Safari 16.1 on macOS Ventura. An eligible Safari tab can subscribe. |
| iPhone and iPad | iOS and iPadOS 16.4 or later support Web Push for installed Home Screen web apps. Open Hourmere from its app icon and sign in there before enabling push. A regular browser tab or Home Screen bookmark that opens a tab cannot subscribe. The [sign-in limitations](#iphone-and-ipad) still apply. |

These are platform capabilities. Anyone implementing the pilot should check for a secure
context, an active `/app/` service worker, `PushManager` and Notifications support before
offering enrollment. Browser, device and organization policy can still block notifications.
Plan to verify delivery on real devices before enabling the feature. [Browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/PushManager.json), [Safari 16.1](https://webkit.org/blog/13399/webkit-features-in-safari-16-1/), [WebKit on iOS and iPadOS](https://webkit.org/blog/13878/).

### VAPID and self-hosting

The browser creates a subscription bound to its service worker registration and selects
the push service. Hourmere's worker would send an encrypted HTTPS message to the resulting
endpoint. For Voluntary Application Server Identification (VAPID), generate a stable P-256
key pair per deployment. The web role supplies the public key to the browser when it
subscribes. The sending worker uses the matching private key to sign requests. Keep that
key in server-side secret storage with a protected backup. Rotating or losing that
key requires affected browsers to resubscribe against the new public key. Use a contact
URI for the deployment operator, such as a role mailbox. VAPID identifies the sender.
The browser subscription has separate encryption material for the payload. [VAPID (RFC 8292)](https://www.rfc-editor.org/rfc/rfc8292.html), [Web Push encryption (RFC 8291)](https://www.rfc-editor.org/rfc/rfc8291.html).

A self-hosted instance would need a browser-trusted HTTPS origin and outbound HTTPS from
its worker to the supported push services, including Apple's APNs Web Push endpoints
under `*.push.apple.com`. Self-hosting keeps subscription management and sending under
the operator's control. Delivery still relies on the browser vendor's push service, so
an instance without that egress cannot deliver pushes. Apple Developer Program membership
and an Hourmere Cloud account are unnecessary. Restrict egress to approved provider
endpoints, validate destinations and reject redirects so submitted subscription URLs
cannot become arbitrary outbound requests. [WebKit on Web Push and APNs](https://webkit.org/blog/13878/).

### Permission and subscription lifecycle

- In signed-in notification settings, explain what can appear on the lock screen, which
  service relays the message and how to stop it. Offer **Enable on this device** only if
  enrollment is supported. Invoke the browser prompt directly from that click or tap.
  Opening the app, installing it, signing in and visiting a public booking page should
  never prompt. Use English and Simplified Chinese for the settings, states and notice.
- Treat browser permission and Hourmere opt-in as separate. Even if permission is already
  granted, wait for an explicit opt-in. Show enabled only after the authenticated server
  registers the subscription. A dismissed prompt leaves push off. After denial, explain
  where to change browser or OS settings and wait for the user to try again.
- Provide **Turn off on this device** and a way to revoke a lost device. Local opt-out
  revokes the server registration and unsubscribes the browser. Confirm server revocation
  before reporting that sending has stopped. If it fails, show the pending state and let
  the user retry. Browser or OS revocation, cleared site data and uninstall can invalidate
  a subscription. Reconcile on the next signed-in visit and remove dead endpoints when
  the provider reports expiration, without silently re-enrolling the device.
- Bind each registration to one account and browser profile or install. Sign-out should
  revoke that install's registration, and changing accounts must never transfer consent.
  Account deletion or device revocation removes the subscription and stops future attempts.
  Only the owner can list or revoke their registrations. REST with OpenAPI, MCP and CLI
  should provide the same owner-scoped status, list and revoke operations. Initial enrollment
  requires a signed-in browser session and the user's gesture. Agent credentials cannot
  grant device permission or submit a subscription on the user's behalf.

### Payload and privacy

Allow a version, an English or Simplified Chinese locale, a fixed generic message kind
and, if needed for deduplication, an opaque random delivery identifier with no access
rights. Render a notice such as “You have an upcoming booking” or “你有一场即将开始的预约”.
Use a fixed same-origin destination such as `/app/bookings`. A click opens the account app,
where current authentication and authorization determine what the user can see.

Exclude names, addresses, times, event titles, meeting details, attendee answers, booking
and calendar identifiers, join and management links, and authorization tokens. Apply that
rule to the rendered notification as well as the encrypted payload. The relay can still
observe routing and timing metadata. Even generic text reveals that a booking exists to
anyone who can see the lock screen, shared desktop or paired wearable. Avoid identifying
data in unencrypted headers such as `Topic`.
[Web Push protocol privacy considerations (RFC 8030)](https://www.rfc-editor.org/rfc/rfc8030.html#section-8), [WebKit on notification surfaces](https://webkit.org/blog/13878/).

Keep only the account binding, per-install management ID, subscription endpoint and
encryption material, locale and lifecycle metadata needed to operate the feature. Treat
endpoint URLs and keys as sensitive, encrypt them at rest and keep them out of API
responses, logs and analytics. Purge the sensitive values when a registration ends and
bound the retention of delivery metadata. Before enabling the pilot, disclose the browser
service dependency and these data flows in the applicable privacy notice.

### Delivery failures

| Failure | Proposed handling |
| --- | --- |
| Missing keys, unavailable worker, blocked egress or failed subscription | Keep push off or show its current unavailable state. Account access and email continue. |
| Provider reports an expired subscription (`404` or `410`) | Retire the matching subscription and stop its queued work. A new enrollment requires user action. |
| Rate limits, transient provider errors or network failures | Use bounded backoff, honor `Retry-After` when present, and retry only while the reminder is current. Treat permanent authentication or malformed requests as operator errors. |
| Cancellation, reschedule, loss of host access or opt-out | Recheck the current booking, recipient and subscription before each send. Discard stale work and use the replacement booking's UTC schedule for a new reminder. An in-flight or accepted push can still appear, and a notice already shown may remain. |
| Offline device, OS suppression or an ambiguous send outcome | Use a short time-to-live that ends before the reminder becomes stale. Focus settings and device state may delay or hide a notification. Provider acceptance confirms neither device delivery nor display. Deduplicate replay where possible; ambiguous network failures can still produce duplicates. |

Subscribe with `userVisibleOnly: true` and show a generic notification in the service
worker without fetching private data in the background. Safari can revoke classic Web Push
subscriptions if they fail to show a visible notification. Keep email as the existing
delivery channel and the signed-in booking page as the source of current booking state.
[WebKit on user-visible push](https://webkit.org/blog/12945/meet-web-push/), [delivery and expiry (RFC 8030)](https://www.rfc-editor.org/rfc/rfc8030.html#section-5).

### Proposed implementation steps

| One-day step | Exit check |
| --- | --- |
| 1. Add opt-in storage, VAPID configuration and self-hosted egress rules. | Feature starts off. Real Postgres tests cover ownership, concurrent enroll/revoke, encrypted storage and endpoint validation with a fake provider. |
| 2. Add browser settings, permission handling and the visible service worker notice. | English and Simplified Chinese tests cover explicit opt-in, dismissal, denial, revoke, shared devices and the signed-in click destination. REST/OpenAPI, MCP and CLI agree on owner-scoped management. |
| 3. Add the host reminder and bounded delivery worker. | Fake-provider tests cover failure and replay, no private payload, cancellation, reschedule, host access loss, opt-out before send and daylight-saving transitions. Email and offline shell checks still pass. |
| 4. Validate and document the pilot. | Record device and browser versions and results on supported desktop browsers, Android and an installed iOS/iPadOS app. Verify lock-screen copy, app closed, opt-out, self-hosting and email fallback. Update configuration, privacy and known-limitations documentation before opt-in rollout. Record unavailable devices or test accounts as pending acceptance. |

中文：安装 Hourmere 目前不会开启推送，也不会请求通知权限。建议今后仅向主动开启的已登录主持人
发送通用预约提醒，保留邮件渠道。iPhone 和 iPad 需要系统 16.4 或更新版本，并从主屏幕上的独立
应用登录后开启。自托管可以自行管理 VAPID 密钥，但送达仍依赖浏览器厂商的服务。锁屏提醒不包含
姓名、预约时间、会议链接或其他私人信息，可在应用内或系统设置中关闭。上线前需完成真机验证。
