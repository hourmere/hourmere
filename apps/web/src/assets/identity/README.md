# Sign-in brand assets

Downloaded from the providers on 2026-10-19. These third-party brand assets are
not licensed under Hourmere's AGPL; the provider's brand permissions apply.

## Google

`google-sign-in-light.svg` is **unmodified** from Google's official
[Sign in with Google asset bundle](https://developers.google.com/static/identity/images/signin-assets.zip):
`Android + Web/SVG/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.svg`.
SHA-256: `6587b180203a99da15c0a041018e15c94ffd9556c4b9855bdc69806081a93791`.

`google-sign-in-dark.svg` is **unmodified** from the same official bundle:
`Android + Web/SVG/Dark/Theme=Dark, Show text=No, Shape=Square, Platform=Android+Web.svg`.
SHA-256: `2f7ecc307b1db0f1738456269ee2c4433b3a73c35060ced67a9afcfc6821e786`.

The [English branding guidelines](https://developers.google.com/identity/branding-guidelines)
(updated 2026-07-07) require the current gradient super G and Google Sans Medium.
The Figma SVG export uses `foreignObject` and a CSS conic gradient, which needs
inline SVG to render reliably. `SocialSignInButton` inserts only these trusted
local SVGs, moves their two inline styles into external CSS for Hourmere's CSP, and
crops the original button boundary. The G keeps its original 20 × 20 geometry,
gradient, and official theme background: white in light mode, #131314 in dark mode,
without a white container. CSS selects the matching official SVG for the user's
color scheme. The 1px button border plus 11px content padding place the G 12px from
the outer edge; the gap after the G remains 10px. No logo is redrawn. The matching
external CSS gradient is tested against every stop in both original sources.

The Google G is a trademark of Google LLC. Its use is permitted here only as a
Google sign-in brand feature under those guidelines and Google's
[third-party brand permissions](https://about.google/brand-resource-center/guidance/).
The documentation has CC BY 4.0 content and Apache 2.0 code-sample notices;
those notices do not grant general rights to Google's trademarks.

`google-sans-medium-latin.woff2` is Google's original Google Sans Medium Latin
font from the [Google Fonts stylesheet](https://fonts.googleapis.com/css2?family=Google+Sans:wght@500&display=swap),
served locally so sign-in never requests a third-party font. The included
`GoogleSans-OFL.txt` contains its copyright and SIL Open Font License 1.1.
Chinese glyphs use the system sans-serif fallback.

English uses the approved **Continue with Google**. Simplified Chinese uses
**继续使用 Google**, explicitly approved in Google's
[Simplified Chinese guidelines](https://developers.google.com/identity/branding-guidelines?hl=zh-cn).
For visual specifications the newer English guidelines take precedence over the
older Chinese translation. While redirecting, the approved label remains intact
and `aria-busy` reports progress.

## Microsoft

`microsoft-symbol.svg` is the **unmodified** official logo linked from Microsoft's
[sign-in branding guidelines](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps):
[original SVG](https://learn.microsoft.com/en-us/entra/identity-platform/media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg).
SHA-256: `929f48f88c8ca7f3f5d294be47ec4caf51acc28ac25340c19a903125d7ecd84a`.
Microsoft offers this asset for application sign-in use under those guidelines;
the Microsoft logo remains Microsoft's trademark and is not relicensed here.

The button follows Microsoft's light/dark redlines: 41px height, Segoe UI 15px
weight 600, 19px colored symbol, 12px visual padding/gaps, white/#5e5e5e light
colors with #8c8c8c border, and #2f2f2f/white dark colors. The 21px SVG has its
own 1px inset, accounted for by the surrounding CSS. English uses Microsoft's
required **Sign in with Microsoft**; Simplified Chinese uses **使用 Microsoft 登录**,
which also appears in Microsoft's [Chinese guidelines](https://learn.microsoft.com/zh-cn/entra/identity-platform/howto-add-branding-in-apps).
The accompanying explanation names personal and work or school accounts as the
guidelines request. Neither provider is enabled by these assets or buttons.
