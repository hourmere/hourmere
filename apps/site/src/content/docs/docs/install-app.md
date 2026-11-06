---
title: Install the app
description: Add Hourmere to your home screen, understand its offline notice, and keep account data online.
---

Open your Hourmere instance over HTTPS, sign in, and visit an account page under
`/app/`. You can install that account interface on supported phones and desktop
browsers. Installation is optional: the same features remain available in your browser.
The public booking pages do not offer installation of the account app.

## iPhone and iPad

In Safari, open the Share menu, choose **Add to Home Screen**, and confirm **Add**.
If your device offers **Open as Web App**, leave it enabled. Open the new Hourmere icon
from your home screen. You may need to sign in again in the installed app.

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
shows an offline notice in English and Simplified Chinese. Reconnect and reload to continue.
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
worker replaces the previous version and removes old app-shell caches; reconnect and
reload an already open tab to pick up the latest interface. If the browser has removed
site storage, the offline notice is available again after a successful online visit.

The [documented reverse proxy](/docs/self-hosting) supports installation without a cloud
service or additional subscription. Keep the application at the origin root, serve
`/app/sw.js` as JavaScript and `/app/manifest.webmanifest` as a web app manifest, and retain
the server's security and cache headers. The worker lives in `/app/`, so its default
maximum scope already covers the app; no broader `Service-Worker-Allowed` header is needed.
Do not broaden its scope to `/` or have the proxy cache private responses. HTTPS is required
except for local development on localhost.

Development builds do not register a service worker. To disable registration in a production
build, set `VITE_PWA_ENABLED=false` when building the web app, then deploy that rebuilt
output. This is a build-time setting, not a running-server environment switch. Existing
installations may still have a registered worker: clear the instance's site data in browser
settings to remove it and its cached static files. These caches contain no account data.
To remove the installed app itself, use your browser or operating system's uninstall option.
