---
title: Booking page branding
description: Apply your space’s logo and accessible brand colours to booking pages, embeds and booking emails.
---

Personal owners and team owners or admins can store a logo and primary colour for their
current space. The feature is available in self-hosted installations without a paid plan.
The saved brand appears on public host and team pages, booking forms and confirmations,
one-time booking links, and invitee manage, reschedule and cancel pages. Inline, popup-button
and floating-button embeds use the same branded booking page. Booking emails to invitees,
guests and hosts use the brand in their HTML part; plain text and calendar invitations are unchanged.

The personal home page (`/{handle}`) uses the host's **personal space** brand around the
event list. Each event card uses its **owning space's** brand, matching the booking page it
opens. Team-owned cards also show the team name; a team without custom branding uses the
Hourmere defaults, not the surrounding personal brand. This includes individually owned
event types created in a team space. Team event types use the **team's** brand, even when
a host belongs to other teams. One-time links follow their event type;
management links and emails follow their booking's owning space. The viewer's signed-in
workspace never chooses the brand. Branding is read when a page loads or an email is sent,
so edits also affect later views and messages for existing bookings.

**Powered by Hourmere** and existing signup links remain on both self-hosted and cloud
pages, including embeds. There is no setting to hide them.

## Save settings

1. Switch to the personal or team space you want to configure.
2. Open **Settings**, then **Booking page branding → Manage branding**.
3. Enter the primary colour, choose a logo file, or use **Remove logo**. Leave the
   colour field empty to clear the custom colour.
4. Review the sample booking page in both **Light** and **Dark** previews and the
   contrast feedback, then choose **Save branding**. Changing spaces discards the old
   space's editor.
5. To remove all custom branding, choose **Reset to default**, then **Save branding**.
   This clears the logo and primary colour for the current space.

The interface supports English and Simplified Chinese. Access and loading failures
are reported separately from unset settings. If the active space changes in another
tab, reload the form before saving again. Logo upload and colour saving are separate
requests: if upload succeeds but colour saving fails, the new logo remains saved;
reload to review the current values before retrying.

## Colour and contrast

Enter a six-digit hexadecimal colour such as `#2457A7`. Short hex, named colours,
transparency and CSS expressions are not accepted. Clear the value to remove the custom
colour. Each space keeps its own setting.

Hourmere computes WCAG 2.x relative luminance and contrast against a white (#FFFFFF) reference background,
white button text and black button text. It selects whichever text colour has the higher
contrast. Every opaque sRGB colour has a black or white text choice meeting 4.5:1, so
rejecting otherwise valid colours would unnecessarily restrict branding. The background
contrast is reported separately: a light brand colour can have readable black button text
while remaining hard to distinguish from a white page. Public pages derive separate light and dark palettes from the saved colour. Colours may
be darkened or lightened to keep links and selected controls readable against the actual
page surfaces; hover colours, button text and focus indicators are derived too. Invalid
stored colours and unset colours retain the default Hourmere palette. Removing a logo
retains the ordinary page layout without a custom logo.

## Logo safety

Upload PNG, JPEG or WebP, at most **512 KiB (524,288 bytes)**, with width and height each
at most **2048 pixels**. SVG and animated images are refused. The server checks the actual
image data and decodes and re-encodes accepted images as PNG before storing them. The
stored result is a PNG with longest side at most **512 pixels** and at most
**64 KiB (65,536 bytes)**. Detailed images may be reduced further to meet this budget;
small images are not enlarged. Existing stored logos are normalized when read, without
a blocking data migration. Original metadata and appended non-image
payloads are not served. Uploaded files are never served as HTML; image responses have
fixed `image/png` content type, `X-Content-Type-Options: nosniff` and a restrictive
Content Security Policy.

The database stores one current logo per organization, addressed by its SHA-256 content
hash. Uploading replaces the previous logo atomically. Old references are unavailable after
replacement at the origin. Public browser caches can retain an already fetched image
until its cache lifetime ends; replacing or removing a logo is not a recall of downloaded
images. Include the database in normal backups; no external object store is required.

## Interfaces and permissions

Branding belongs to the current organization. Personal settings require the personal
owner; team settings require a current owner or admin. An ordinary team member cannot
read or edit these administrative settings. Read API keys require `read` or `full` scope;
changes require `full`. Role checks still apply to every credential. Every logo upload
and every saved change is recorded in the [audit log](/docs/audit-log) with the credential
used and which setting changed, never the image or the colour.

REST uses `GET /api/v1/branding` and `PATCH /api/v1/branding`. Send only the fields to change:

```json
{
  "brandPrimaryColor": "#2457A7"
}
```

Omitted fields are preserved; `null` clears a setting. `brandLogo` references the current
logo already uploaded to the same space; it cannot fetch an external URL or borrow another
space's image. Browser session writes include `X-Expected-Organization-Id`, binding the
action to the space shown when the form was opened. Reload after a space-context conflict.

Malformed colours or logo references return REST `400 invalid_request`. MCP rejects
them during tool input validation. Neither interface returns `invalid_brand_color`
for malformed input.

MCP exposes `get_branding` and `set_branding` with the same permissions and validation.
Upload binary images through REST or CLI first; MCP can then reference the uploaded logo.

Upload raw image bytes to `POST /api/v1/branding/logo` with the matching `Content-Type`
(`image/png`, `image/jpeg` or `image/webp`). This is a binary body, not multipart form data
or base64 JSON. The response contains the updated branding, including `brandLogo`.
Authorized clients can retrieve it at `GET /api/v1/branding/logo/{hash}` in the same space.
The administrative image endpoint is protected; a hash is not a public sharing link.
Public page responses include a same-origin `logoUrl`, with the space name as alternative
text and a reserved, bounded display area. The deprecated `logoDataUrl` field is now null.
`GET /api/v1/public/branding/{organizationId}/logo/{hash}` serves the current normalized
PNG with `Cache-Control: public, max-age=31536000, immutable`. The hash identifies the
bytes actually served. Lookup is scoped to the named organization: another organization's
hash and an unknown hash return the same unavailable response. A saved logo is a public
asset; the administrative image endpoint still requires authorization. No third-party
image URL is requested. Booking emails attach the same small PNG inline with a Content-ID
reference; viewing the email logo does not fetch a remote image or report an open.

The CLI uses the same API key and instance options as its other commands:

```sh
hourmere branding get
hourmere branding upload --file logo.png --content-type image/png
hourmere branding set --input branding.json
```

Save the JSON example above as `branding.json`. To clear both settings, use
`{"brandPrimaryColor":null,"brandLogo":null}`. A repeated upload of the same image has the
same content hash; it does not retain another copy. Concurrent changes are serialized;
the last committed write wins for fields both callers change. Clients should send only
edited fields and reload before restoring an older logo reference.

## Preview walkthrough (text descriptions)

- **Light screenshot description:** the settings editor includes a sample booking
  card on a light surface. The space logo appears above the sample meeting title;
  available-time and booking controls use the accessible light palette. Contrast feedback
  identifies the selected button text and the saved colour's contrast against white.
- **Dark screenshot description:** the same sample booking content appears on dark
  surfaces. Links, selected times and the booking action use the derived dark palette;
  the uploaded logo keeps its original colours. Compare both previews before saving,
  especially for transparent logos. The preview is illustrative and creates no booking.
- **Mixed-space home screenshot description:** a personal-branded header surrounds an
  event list. A team-owned event card names that team and shows its own colours and logo.
  Opening the card preserves that event's owning-space brand.

中文：个人主页外框使用个人空间品牌，每张事件卡片与其预约页使用同一所属空间品牌；
团队事件卡片显示团队名称，未配置品牌的团队使用默认样式，不继承个人品牌。
设置页提供浅色、深色示例预约预览及对比度反馈，并可重置为默认品牌。
上传支持 PNG、JPEG、WebP（不含动画），原文件最多 512 KiB、每边最多 2048 像素；
服务端输出最长边不超过 512 像素、最多 64 KiB 的 PNG，旧图片读取时同样处理。
网页使用按组织隔离、由内容哈希标识的可缓存图片地址；邮件仍使用 CID 内嵌图片。
邮件客户端可能调整深色模式颜色、隐藏图片或将其显示为附件，不能保证与网页完全一致。

## Current limits

- There are no custom fonts, theme CSS, per-event branding or removal of Hourmere attribution.
- Exact brand colours can change to meet contrast requirements. The administrative
  `backgroundContrast` still reports contrast against white only; rendered pages use
  separate palettes for their light and dark surfaces.
- Emails request a light colour scheme with explicit inline colours. Email clients can
  override colours in dark mode, hide inline images or show them as attachments; identical
  appearance across clients is not guaranteed. Text and actions remain usable without images.
- Logo colours are not analysed for contrast. Use a logo that works on light and dark
  backgrounds; the space name remains its alternative text.
- Popup and floating embed trigger buttons retain their neutral styles; the booking page
  inside the iframe carries the brand.
- Sign-in and team invitation emails keep the default Hourmere identity. Branding does not
  change sender addresses, subjects, delivery settings or calendar invitation contents.
