---
title: Booking page branding
description: Store an organization logo and primary colour with safe image handling and readable button text.
---

Personal owners and team owners or admins can store a logo and primary colour for their
current space. The feature is available in self-hosted installations without a paid plan.
These settings prepare the organization for branding; public booking pages and emails do
not apply them yet.

## Save settings

1. Switch to the personal or team space you want to configure.
2. Open **Settings**, then **Booking page branding → Manage branding**.
3. Enter the primary colour, choose a logo file, or use **Remove logo**. Leave the
   colour field empty to clear the custom colour.
4. Choose **Save branding**. Review the saved logo preview, button-text choice and
   contrast against white. Changing spaces discards the old space's editor.

The interface supports English and Simplified Chinese. Access and loading failures
are reported separately from unset settings. If the active space changes in another
tab, reload the form before saving again. Logo upload and colour saving are separate
requests: if upload succeeds but colour saving fails, the new logo remains saved;
reload to review the current values before retrying.

## Colour and contrast

Enter a six-digit hexadecimal colour such as `#2457A7`. Short hex, named colours,
transparency and CSS expressions are not accepted. Clear the value to remove the custom
colour. Each space keeps its own setting.

Hourmere computes WCAG 2.x relative luminance and contrast against white page background,
white button text and black button text. It selects whichever text colour has the higher
contrast. Every opaque sRGB colour has a black or white text choice meeting 4.5:1, so
rejecting otherwise valid colours would unnecessarily restrict branding. The background
contrast is reported separately: a light brand colour can have readable black button text
while remaining hard to distinguish from a white page. These calculations describe the
stored colour, not an accessibility certification of future pages or emails.

## Logo safety

Upload PNG, JPEG or WebP, at most **512 KiB (524,288 bytes)**, with width and height each
at most **2048 pixels**. SVG and animated images are refused. The server checks the actual
image data and decodes and re-encodes accepted images as PNG before storing them. The
encoded result must also fit the size limit. Original metadata and appended non-image
payloads are not served. Uploaded files are never served as HTML; image responses have
fixed `image/png` content type, `X-Content-Type-Options: nosniff` and a restrictive
Content Security Policy.

The database stores one current logo per organization, addressed by its SHA-256 content
hash. Uploading replaces the previous logo atomically. Old references are unavailable after
replacement. Include the database in normal backups; no external object store is required.

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

MCP exposes `get_branding` and `set_branding` with the same permissions and validation.
Upload binary images through REST or CLI first; MCP can then reference the uploaded logo.

Upload raw image bytes to `POST /api/v1/branding/logo` with the matching `Content-Type`
(`image/png`, `image/jpeg` or `image/webp`). This is a binary body, not multipart form data
or base64 JSON. The response contains the updated branding, including `brandLogo`.
Authorized clients can retrieve it at `GET /api/v1/branding/logo/{hash}` in the same space.
The image endpoint is protected; a hash is not a public sharing link.

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

## Current limits

- Storage and validation are available now. Applying branding to public booking pages,
  embeds and email templates is a separate change.
- There are no custom fonts, theme CSS, per-event branding or removal of Hourmere attribution.
- The contrast reference is a white page. Future themes need to check their actual
  backgrounds and other interface elements separately.
- Logo colours are not analysed for contrast. Keep meaningful content accessible through
  text as well as images when the display feature becomes available.
