# Shared design tokens

The web app is the first consumer of `@hourmere/design-tokens`. Its root palette,
type scale, spacing, radii and standard shadow provide the package defaults. The
site, standalone embed shell and email templates can adopt matching values in
later changes while keeping their existing appearance.

## Inventory

The tables record pre-migration declarations. A single value applies to both
themes unless a light and dark pair is shown. A dash indicates that a consumer
has no equivalent role. Site values cover the marketing and legal pages unless
marked Starlight. Widget values here describe the popup shell on the host page.
The booking UI inside the iframe uses the web app stylesheet and the existing
embedded layout. [Embedded layout stylesheet](../apps/web/src/public/embed.css)

### Colour

| Token | Web app | Site | Widget shell | Email templates | Shared name | Differences |
| --- | --- | --- | --- | --- | --- | --- |
| Cobalt | `--cobalt` `#1f4fd8` | `--cobalt` and light `--sl-color-accent` `#1f4fd8` | — | `emailLinkStyle`, masthead and button default `#1f4fd8` | `--hm-color-cobalt` | Exact brand match. |
| Strong cobalt | `--cobalt-strong` `#1a43b8` | — | — | — | `--hm-color-cobalt-strong` | Web button hover primitive. |
| Deep mere | `--deep-mere` `#0a1e4a` | `--deep-mere` and light `--sl-color-accent-high` `#0a1e4a` | — | — | `--hm-color-deep-mere` | Exact brand match. |
| Mist | `--mist` `#eaf0fd` | `--mist` and light `--sl-color-accent-low` `#eaf0fd` | — | — | `--hm-color-mist` | Exact brand match. |
| Amber | `--amber` `#f2a33a` | `--amber` `#f2a33a` | — | — | `--hm-color-amber` | Both browser themes reserve amber for graphics. |
| Ink | `--ink` `#0e1015` | `--ink` and dark `--sl-color-black` `#0e1015` | — | — | `--hm-color-ink` | Exact brand match. |
| Page background | `--bg` `#f7f9fe` / `#0e1015` | `--bg` `#ffffff` / `#0e1015` | `background: Canvas` | Body and table `bgcolor` / `background-color` `#ffffff` | `--hm-color-bg` | Dark web and site match. Different light page backgrounds, native canvas and email white stay in use. |
| Surface | `--surface` `#ffffff` / `#151c2e` | `--surface` `#ffffff` / `#151c2e` | Button `background: Canvas` | Layout table and secondary buttons `#ffffff` | `--hm-color-surface` | Web and site match. Shell and mail deliberately use native or light-only surfaces. |
| Muted surface | `--surface-muted` `#eaf0fd` / `#111a33` | `--bg-soft` `#eaf0fd` / `#111a33` | — | — | `--hm-color-surface-muted` | Exact match for the muted surface. |
| Body text | `--text` `#0e1015` / `#e9edf7` | `--text` `#0e1015` / `#e9edf7` | `color: CanvasText` | Body `color: #111` | `--hm-color-text` | Web and site match. Preserve the widget's native text and the email literal. |
| Muted text | `--muted` `#475066` / `#a9b3c9` | `--muted` `#475066` / `#a9b3c9` | — | Inline `#555` for labels and footer, `#777` for struck-out details | `--hm-color-muted` | Web and site match. Mail keeps its distinct inline roles. |
| Border | `--border` `#d6deef` / `#283252` | `--border` `#d6deef` / `#283252` | `border: 1px solid GrayText` for dialog and close control | Footer border `#ddd` | `--hm-color-border` | Web and site match. Widget borders deliberately use system colours. Mail separator stays `#ddd`. |
| Strong border | `--border-strong` `#7a8ab0` / `#64719a` | Waitlist input uses `--muted` `#475066` / `#a9b3c9` | Native `GrayText` border | — | `--hm-color-border-strong` | Intentional form contrast and control styling differences. |
| Link and focus | `--link`, `--focus` `#1f4fd8` / `#8faeff` | `--link` also drives focus `#1f4fd8` / `#8faeff` | `outline-color: Highlight` | `emailLinkStyle` `#1f4fd8` | `--hm-color-link`, `--hm-color-focus` | Web and site match. Widget focus deliberately follows the system. Email uses the light value inline. |
| Primary action | `--accent` `#1f4fd8` / `#3d68e6` | `--button-bg` `#1f4fd8` in both themes. Starlight `--sl-color-accent` `#1f4fd8` / `#5b82f0`. | — | Primary button `bgcolor` / `background-color` `#1f4fd8` | `--hm-color-accent` | Common light value. Site and Starlight keep their distinct dark values. |
| Primary hover | `--accent-hover` `#1a43b8` / `#3360e0` | `--button-hover-bg` `#0a1e4a` / `#1f4fd8`, `--button-hover-border` `#0a1e4a` / `#8faeff` | — | — | `--hm-color-accent-hover` | Intentional separate hover treatments. |
| Action foreground | `--accent-text`, `--danger-text` `#ffffff` | `--button-text` `#ffffff` | Close control `color: CanvasText` | Default primary button `color: #ffffff` | `--hm-color-accent-text`, `--hm-color-danger-text` | Exact browser button match. Branded mail can select a different text colour. |
| Soft accent | `--accent-soft` `#eaf0fd` / `#16244a` | `--accent-soft` and `--sl-color-accent-low` `#eaf0fd` / `#16244a` | — | — | `--hm-color-accent-soft` | Exact match. |
| Text on soft accent | `--accent-soft-text` `#0a1e4a` / `#dbe5ff` | Starlight `--sl-color-accent-high` `#0a1e4a` / `#c3d2fb` | — | — | `--hm-color-accent-soft-text` | Light values match. Starlight keeps its dark accent ramp. |
| Danger action and hover | `--danger` `#b42318` / `#d13438`, `--danger-hover` `#912018` / `#b42318` | — | — | — | `--hm-color-danger`, `--hm-color-danger-hover` | Existing web status roles. |
| Danger surface, border and text | `--danger-soft` `#fef0ee` / `#2c1517`, `--danger-border` `#f4b8b0` / `#6b2a2d`, `--error-text` `#b42318` / `#ff9a94` | — | — | — | `--hm-color-danger-soft`, `--hm-color-danger-border`, `--hm-color-error-text` | Existing web contrast pairings. |
| Success surface, border and text | `--success-soft` `#ecf8f1` / `#11261c`, `--success-border` `#9fd8b8` / `#2b6a4a`, `--success-text` `#11603a` / `#9fe0bd` | — | — | — | `--hm-color-success-soft`, `--hm-color-success-border`, `--hm-color-success-text` | Existing web contrast pairings. |

### Spacing, shape, typography and elevation

| Token | Web app | Site | Widget shell | Email templates | Shared name | Differences |
| --- | --- | --- | --- | --- | --- | --- |
| Spacing 1 | `--space-1` `4px` | `4px` inset timeline marker ring and legal quote border | — | Join link margin `4px` | `--hm-space-1` | Same measurement. Component roles stay local. |
| Spacing 2 | `--space-2` `8px` | Button gap and card heading margin `8px`. Docs touch-copy padding `0.5rem`. | Compact header top padding `8px` | Booking footer and fallback margins `8px` | `--hm-space-2` | The `rem` value scales with root text size. Keep its unit. |
| Spacing 3 | `--space-3` `12px` | Section heading margin and homepage action gap `12px`. Docs cards `0.75rem`. | Header and dialog gap, compact header inline padding `12px` | Answer paragraph margin and button vertical padding `12px` | `--hm-space-3` | Exact px matches. Keep docs `rem` and Outlook padding semantics. |
| Spacing 4 | `--space-4` `16px` | `--gutter` `16px` below `720px`, preview header padding `16px`. Docs cards `1rem`. | Desktop dialog padding `16px` | Button wrapper, footer and booking cell padding `16px` | `--hm-space-4` | Exact px matches. Responsive switches and `rem` stay local. |
| Spacing 5 | `--space-5` `24px` | `--gutter` `24px` at `720px` and up, card padding `24px` | Popup viewport inset in width calculation `24px` | Layout cell padding, masthead, logo and footer margin `24px` | `--hm-space-5` | Exact matches used in different layout roles. |
| Spacing 6 and 7 | `--space-6` `32px`, `--space-7` `48px` | Homepage steps and hero gaps `32px`, `48px` | — | — | `--hm-space-6`, `--hm-space-7` | Same measurements. Homepage also retains its own breakpoints and section spacing. |
| Standard radius | `--radius` `10px` | `--radius` `14px` for cards. Buttons, waitlist field and preview controls `10px`. Preview outer card `18px`. | Dialog `12px` desktop, `0` compact | — | `--hm-radius` | Site control value matches. Card and dialog shapes intentionally differ. |
| Small radius | `--radius-small` `6px` | Skip link and header navigation `8px`, focus outline corners `4px` | Close control `8px` | `emailButton` `border-radius: 6px` | `--hm-radius-small` | Web and mail match. Site and widget use their established shapes. |
| Sans family | `--font` `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif` | `--font` `"Manrope Variable", system-ui, -apple-system, "Segoe UI", sans-serif`. `--sl-font` `"Manrope Variable", system-ui, sans-serif`. | `system-ui, sans-serif` | `fontFamily` `-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif` | `--hm-font-sans` | Intentional font stacks for the application, marketing/docs, standalone shell and email clients. |
| Monospace family | `--mono` `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace` | `--mono` same on marketing/legal pages | — | — | `--hm-font-mono` | Exact match. Starlight retains its own code styling. |
| Small text | `--text-xs` `0.8125rem`, `--text-sm` `0.875rem` | Preview helper `13px`, eyebrow and preview secondary text `14px`, inline code `0.92em` | — | Footer and fallback `13px` | `--hm-text-xs`, `--hm-text-sm` | Px examples match at a `16px` root size. Keep the current unit and role in each consumer. |
| Body and large text | `--text-md` `1rem`, `--text-lg` `1.125rem`. Body line height `1.55`. | Body `17px` / `1.6`, button `16px`, section intro `18px` | Dialog `16px/1.5`, title `600 18px/1.5` | Body `16px` / `1.5` | `--hm-text-md`, `--hm-text-lg` | Similar sizes use intentional units and line heights. Marketing body is larger. |
| Display text | `--text-xl` `1.5rem`, `--text-2xl` `1.75rem`. Heading line height `1.25`. | Section heading `clamp(28px, 4vw, 38px)`, hero title `clamp(36px, 6vw, 52px)`. Heading line height `1.2`. | Close glyph `28px/1` | Masthead `20px` / weight `700`, button line height `20px` | `--hm-text-xl`, `--hm-text-2xl` | Intentional size, weight and role differences. |
| Standard shadow | `--shadow` `0 1px 2px rgb(14 16 21 / 6%), 0 2px 8px rgb(14 16 21 / 6%)` / `none` | Booking illustration `10px 10px 0 var(--accent-soft)` and selected-day inset `0 0 0 2px var(--cobalt)` | Dialog backdrop `rgb(0 0 0 / .5)` and no box shadow | — | `--hm-shadow` | Intentional separate elevation and backdrop treatments. |

Inventory sources

- Web app. [Root stylesheet](../apps/web/src/styles.css)
- Site. [Global styles](../apps/site/src/styles/global.css), [homepage](../apps/site/src/pages/index.astro),
  [booking preview](../apps/site/src/components/BookingPreview.astro), [Starlight styles](../apps/site/src/styles/starlight.css)
- Embed shell. [Widget stylesheet string](../apps/web/src/embed/widget.ts)
- Email. [Layout and buttons](../packages/mail/src/layout.ts), [booking templates](../packages/mail/src/booking.ts),
  [delivery templates](../packages/mail/src/index.ts)

## Package boundary and themes

`@hourmere/design-tokens` is a private npm workspace with no runtime dependencies.
Its TypeScript entry exports `tokens` and `darkTokens`, flat maps keyed by
`--hm-*` custom property. `tokens` contains base values and `darkTokens` contains
only dark overrides. Both maps contain concrete CSS values. Run
`npm run generate --workspace @hourmere/design-tokens` after editing the maps to
regenerate the committed `@hourmere/design-tokens/tokens.css` stylesheet. The
workspace build verifies the generated file. The stylesheet declares only
custom properties, with base values at `:root` and overrides under
`prefers-color-scheme: dark`.

The web app imports the stylesheet at its root and aliases its existing token
names to the package properties. It retains control of `color-scheme`, and its
public-route, organization-brand and print rules continue to set the local
semantic names where they apply. The iframe picks up the web defaults in its own
document. The standalone widget's shadow DOM continues to request the browser's
native light and dark canvas colours. A future widget migration can use concrete
matching values from the TypeScript map inside the shadow stylesheet.

The site keeps its explicit `data-theme` selection ahead of system preference
and keeps printing light. When it adopts shared values, resolve the base and dark
maps under its existing selectors so explicit light still works on a dark system
and explicit dark still works on a light system. Starlight keeps its own theme
selectors and unmatched accent values. Email stays light and renders concrete
values inline, including Outlook-compatible `bgcolor` and spacing. Its branding
transform depends on exact emitted style patterns and remains part of any later
template adoption. [Email branding transform](../packages/mail/src/branding.ts)

Shell sizes such as `--topbar-height` (`60px`), `--sidebar-width` (`220px`),
`--content-narrow` (`720px`), `--content` (`960px`), `--content-wide` (`1200px`)
and `--shell-max` (`1440px`) belong to web layout. The site's `--maxw` (`1120px`),
widget popup and iframe sizes, and email's `600px` table belong to their own
layout. Component-only measurements, image assets, browser theme metadata, the
standalone offline fallback and server-rendered confirmation pages use their
existing styling contracts.

## Compatibility

Keep existing variable names as consumer-side aliases until all consumers of
those names have migrated. Keep scoped overrides on the existing semantic names
while those aliases are in use. Adopt matching values without changing a colour,
unit, typeface or shadow. Where values differ, retain them in the consumer and
evaluate a separate visual change only if needed. Computed styles in both
themes, existing screenshot baselines and layout tests are the compatibility
checks for the app migration.
