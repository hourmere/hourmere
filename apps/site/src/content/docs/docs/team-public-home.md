---
title: Team public home
description: Control which saved team event types appear in the public catalogue.
---

The team home catalogue lets visitors find listed booking options at `/team/{teamSlug}` on
your instance. It is off by default. Each event opens its existing booking page at
`/team/{teamSlug}/{slug}`.

## Enable a team's catalogue

An instance operator sets `TEAM_PUBLIC_HOME_ORGANIZATION_IDS` to the organization UUIDs of
the teams that have agreed to publish a catalogue, and restarts the server. The list accepts up
to 256 comma-separated UUIDs. Empty entries, including a trailing comma, are ignored.
Nonempty entries must be valid UUIDs. An enabled directory remains public when the team
enforces SSO for member access. Remove the team's UUID and restart to turn off its catalogue.
Allowlisting an organization by ID ties the setting to the team when its slug changes.
With a team-scoped API key, `hourmere whoami` shows the team's UUID in `organization.id`.

The catalogue includes saved, active, listed event types owned by the team, with the hosts
needed for ordinary team booking. Round-robin events need explicit activation and at least
one eligible host. The response includes each event's title, description, default duration and
location type.
To see available times, open an event's booking link.

Unlisted events are excluded from the catalogue. Eligible unlisted events are still accessible
to anyone with their direct booking links. One-time links use a separate private sharing flow.
The catalogue never includes those links, host details, location details or booking records.
Creating a one-time link leaves the event's listing setting in place. Hide the event to keep its
regular booking address out of the catalogue.

## Display states

The visitor page shows the team's saved name and public address using the team slug's
exact capitalization. An enabled team with no eligible events shows “This team has no public
events right now.” Disabled, unknown and ineligible addresses all show “This team page is
unavailable.” Only a successful catalogue read displays the team's information. The page shows
progress while loading and offers a retry after a request failure.

## Read the catalogue

Use the exact-case team slug, for example `Cobaltmere`. Each read returns the full catalogue.

- **REST** `GET /api/v1/public/teams/Cobaltmere`. No sign-in is needed. `200` with
  `eventTypes: []` means the catalogue is enabled and empty. `404 team_not_found` means
  the catalogue is unavailable.
- **MCP** Call `get_public_team` with `{ "handle": "Cobaltmere" }` on an authenticated connection.
- **CLI** Run `printf '%s\n' '{"handle":"Cobaltmere"}' | hourmere team-home --input -` using your
  configured API key.

## 中文

团队公开首页目录默认关闭。访客可在 `/team/{teamSlug}` 查看目录，点击活动链接进入
`/team/{teamSlug}/{slug}` 预约页。

运营者将同意公开的团队组织 UUID 加入 `TEAM_PUBLIC_HOME_ORGANIZATION_IDS` 后重启服务。最多可填
256 个 UUID，以逗号分隔。忽略空项和末尾逗号，非空项必须是有效的 UUID。团队强制成员使用单点登录后，
已启用的目录仍可公开访问。移除 UUID 并重启即可关闭该团队的目录。使用组织 ID 可让团队更改地址标识后
继续保留同一开关设置。使用属于该团队的 API 密钥运行 `hourmere whoami`，可在 `organization.id`
中查看团队 UUID。

目录只收录已保存、已启用、列出且符合主持人资格要求的团队活动。轮询活动还需明确启用，并至少有一位
符合条件的主持人。接口返回标题、说明、默认时长和地点类型，实际可约时间在活动预约页中查看。隐藏活动
不会列出，但符合条件的隐藏活动仍可通过直达链接访问。目录不会公开一次性链接、主持人资料、地点详情或
预约记录。创建一次性链接时，活动保留原来的可见性设置；如需从目录中移除常规预约地址，请隐藏该活动。

浏览器首页会显示已保存的团队名称和公开地址，地址中的团队标识区分大小写。已启用但目录为空时，
显示“此团队目前没有公开活动。”未启用、找不到或不符合条件时，统一显示“此团队页面暂不可用。”
只有读取成功后才显示团队信息。加载期间显示进度，请求失败后提供重试操作。

使用大小写完全一致的团队标识读取目录。目录通过一次请求读取，无需翻页。公开 REST 为
`GET /api/v1/public/teams/{handle}`，无需登录。
`200` 和空 `eventTypes` 数组表示目录已启用但没有可列出的活动。`404 team_not_found` 表示目录不可用。
通过已认证的 MCP 连接调用 `get_public_team`，或使用已配置 API 密钥的 `hourmere team-home --input -`。
两者都接收 `{ "handle": "Cobaltmere" }`。
