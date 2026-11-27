# Team public home

The visitor page at `/team/{teamSlug}` on the instance's `PUBLIC_URL` lists saved public events
for an explicitly enabled team. The address uses the team slug's exact stored case. Each event
opens its existing booking page at `/team/{teamSlug}/{slug}`.

## Enablement and data boundary

The operator sets `TEAM_PUBLIC_HOME_ORGANIZATION_IDS` and restarts the server. It accepts up to
256 comma-separated organization UUIDs. The parser trims whitespace, ignores empty entries
including a trailing comma, and normalizes case. An empty list keeps every team home off.
Invalid nonempty entries stop startup. Using the immutable organization ID keeps a renamed
team's opt-in with that team. Public lookups use the current slug and exclude personal
organizations. The former address stops resolving immediately and is reserved for the same team
to reclaim for 90 days. If another team claims it after the reservation expires, that team's
catalogue still needs its own opt-in.

An enabled directory remains public when the team enforces SSO for member access. To take the
directory offline, remove the team's UUID from the list and restart the server.

The catalogue uses saved, active, listed, non-deleted, team-owned event types. Individual and
collective events must have valid current hosts under the ordinary team booking rules. Round-robin
events require explicit activation and at least one eligible host. Events follow their saved
position, with event ID as a stable tie-breaker. Available times are checked when the visitor
opens the booking page.

The response includes `team.name`, `team.slug` and `eventTypes`. Each event contains `slug`,
`title`, `description`, `durationMinutes` and `location` (only `{kind}`, or `null`). The projection
excludes host and member data, internal IDs, location details, booking information and private
link credentials. Unlisted events are absent from the catalogue and may still be opened by
their direct booking links when eligible. One-time links have their own private sharing flow.
Creating a one-time link leaves the event's listing setting in place. Hide the event to keep its
regular booking address out of the catalogue.

## Visitor display contract

| Read outcome | Display in English | 中文显示 |
| --- | --- | --- |
| Enabled team with listed events | Team name as the page heading, public address, and links for the returned event types. | 以团队名称为标题，显示公开地址及返回的活动链接。 |
| Enabled team with an empty `eventTypes` array | Team name and public address, with “This team has no public events right now.” | 保留团队名称和公开地址，并提示“此团队目前没有公开活动。” |
| Unavailable (`team_not_found`) | “This team page is unavailable.” The same view covers disabled, unknown and ineligible teams. | 显示“此团队页面暂不可用。”未启用、找不到或不符合条件时使用同一页面。 |
| Request still loading or failed | Show loading progress or a retry action according to the outcome. | 分别显示加载进度或重试操作。 |

Only a successful response supplies the team's name, address and event data. The unavailable
view uses neutral copy and does not disclose whether a team exists or whether it opted in.

## REST, MCP and CLI

| Interface | Read one team by exact-case slug |
| --- | --- |
| REST | `GET /api/v1/public/teams/{handle}`. Anonymous access is supported. |
| MCP | `get_public_team` with `{ "handle": "Cobaltmere" }`. An authenticated MCP connection is required. |
| CLI | `printf '%s\n' '{"handle":"Cobaltmere"}' \| hourmere team-home --input -` using the CLI's configured API key. |

All three return the same projection in a single response without pagination. REST returns
`200` for enabled teams, including an empty catalogue, and `404 team_not_found` for unavailable
teams. It applies the public page rate limit and returns `Cache-Control: no-store`. MCP and CLI
require an authenticated connection and support `full`, `read` and `bookings` keys. MCP OAuth
uses the existing `mcp:tools` grant.

中文：团队公开首页目录默认关闭。运营者在 `TEAM_PUBLIC_HOME_ORGANIZATION_IDS` 中填写允许公开的
组织 UUID，最多 256 个，以逗号分隔，变更后重启服务。忽略空项和末尾逗号，非空项必须是有效的 UUID。
团队强制成员使用单点登录后，已启用的目录仍可公开访问。关闭目录需从列表移除团队 UUID 并重启服务。
公开查询使用当前团队地址标识（slug）的原始大小写。个人空间、未启用团队和未知地址统一返回
`team_not_found`。改名后旧地址立即失效，并为原团队保留 90 天，期间原团队可取回。保留期结束后，
若其他团队取得该地址，仍需为该团队单独启用目录。已启用团队没有可展示活动时，仍返回团队名称、
地址标识和空数组。仅收录已保存、
已启用、列出且未删除的团队活动。活动还须满足普通的团队主持人资格及轮询启用要求。目录只提供活动标题、
地址标识、说明、默认时长及地点类型等公开字段，不枚举隐藏活动、一次性链接、主持人或预约信息。
创建一次性链接时，活动保留原来的可见性设置。如需从目录中移除常规预约地址，请隐藏该活动。
访客可在 `/team/{teamSlug}` 查看目录，点击活动链接进入预约页。目录通过一次请求读取，无需翻页。
