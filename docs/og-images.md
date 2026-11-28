# Booking-link preview images

Sharing a listed personal or team event's booking page can show a 1200 × 630 PNG preview.
The server includes the image metadata in the HTML so preview crawlers can read it before
JavaScript runs.

## Public data boundary

The event-specific image can contain exactly these booking-page values:

- The saved event title.
- The saved default duration in minutes.
- The public host display name for a personal event, or the public team name for a team event.
- The owning space's optional public primary brand colour, after the normal public branding validation.

The template also has fixed Hourmere artwork. It uses no avatar or logo. Descriptions, internal
notes, email fields, attendees, booking answers, calendar data, conference links, private
location details, IDs and link credentials are outside the projection. The renderer receives
only the four allowed event values and makes no network requests.

Personal images require a valid, current public booking address and a saved, listed, active,
non-deleted event. Team images also require the normal public team event host eligibility and
scheduling-mode checks, including explicit round-robin activation. A hidden event still books
through its existing direct link and gets the generic image. Private, secret, unpublished,
inactive, deleted and missing targets all get the same generic Hourmere PNG, with the same
status, cache headers and validator. One-time booking links and routing continuation capabilities
are outside this surface. Routing does not publish an event or grant an image-specific exception
for a hidden target.

The configured public origin supplies the absolute image URL. Team home publication controls
the team directory separately from its directly bookable events. Clearing the organisation's
brand colour restores the default palette. The current instance and organisation settings offer
no white-label or attribution toggle.

## Requests and cache

The personal image is at `/api/og/event/{handle}/{slug}` and the team image is at
`/api/og/team/{teamSlug}/{slug}`. The server resolves current eligibility and display values
before serving a cached render or considering a conditional request. A matching
`If-None-Match` returns 304. Changes to the rendered content change the strong ETag.
After an address changes, an origin request to the former address gets the generic image
as soon as the old address ceases to resolve. HTTP caches may store the image and must
revalidate before reuse (`public, max-age=0, must-revalidate`). Messaging apps may retain
previews according to their own policies.

The image routes use the existing public client-IP rate limiter. Rendering constrains
input sizes and concurrent work and reuses a bounded cache of completed images.

中文：公开且已列出的个人或团队预约链接可显示 1200 × 630 预览。图片只使用已保存的活动标题、
默认时长、公开主持人或团队名称以及已公开的品牌主色，不使用头像、标志、邮箱、受邀人资料、
私人地点或链接凭证。隐藏、停用、删除、未公开及不存在的活动统一返回同一张 Hourmere 通用图。
一次性预约和分流续接链接不参与此功能。HTTP 缓存每次复用前须重新验证，服务器会检查当前活动状态。
聊天应用可能按其自身策略保留旧预览。
