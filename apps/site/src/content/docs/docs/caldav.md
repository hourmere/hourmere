---
title: CalDAV connections
description: Connect iCloud, Nextcloud, Fastmail or another HTTPS CalDAV server, choose calendars and understand privacy and limitations.
---

Connect a CalDAV account from **Calendars → Connect CalDAV**. Choose which calendars
Hourmere checks for conflicts and, optionally, one writable calendar for booking copies.
This is separate from signing in to Hourmere. Self-hosted instances have the same feature.

**No real-account acceptance has been completed.** Automated tests use synthetic CalDAV
servers. Presets provide starting URLs and guidance, not a compatibility guarantee.

## Before connecting

Your operator must configure `CALENDAR_ENCRYPTION_KEY` and run the background worker.
See [configuration](/docs/configuration#caldav). Use a dedicated provider app password
with calendar access. Never enter your primary Apple Account password or a two-factor
verification code. Hourmere sends Basic authentication only over certificate-verified HTTPS.

| Preset | Server and credentials | What to check |
| --- | --- | --- |
| iCloud | `https://caldav.icloud.com/`, Apple Account login and an app-specific password. | Enable two-factor authentication and create an [app-specific password](https://support.apple.com/en-us/102654). This starting URL is an integration assumption, not an Apple endpoint guarantee. Discovery may use another exact shard origin; your operator must explicitly approve it. |
| Nextcloud | Your installation’s `https://<host>[/prefix]/remote.php/dav/` URL, username and app password. | Keep the installation prefix. Use the DAV address supplied by your installation. Private addresses need an operator exception; certificates must still be trusted. See [Nextcloud’s client setup](https://docs.nextcloud.com/server/latest/user_manual/en/groupware/sync_osx.html). |
| Fastmail | `https://caldav.fastmail.com/`, full username and an app password with calendar access. | Basic plans do not include CalDAV. See [Fastmail’s server settings](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports). |
| Other CalDAV server | Your server’s HTTPS DAV URL, username and app password. | The server must support usable VEVENT discovery and expanded event reads. Do not embed credentials in the URL. |

## Connect and choose calendars

1. Open **Calendars → Connect CalDAV**, choose a preset and enter the server URL,
   username and app password. Nextcloud and generic servers need your installation’s URL.
2. Discover calendars. This step does not save the credentials or create a connection.
   A failed or incomplete discovery does not mean you have no calendars.
3. Explicitly choose calendars to check for conflicts and one writable booking destination,
   or no destination. A write destination need not be a conflict calendar. New calendars
   are never automatically selected. The account-wide limit is twenty conflict calendars.
4. Save. Hourmere checks discovery again before saving the encrypted connection and your
   choices. Wait for the first successful sync before relying on availability.

Only your live browser session may discover, connect, reconnect or change CalDAV calendar
settings. Team administrators cannot manage another person’s connection. Connections belong
to you across spaces. Provider passwords are never accepted by MCP tools, the CLI or API
keys; do not paste them into agent conversations.

The browser uses additive OpenAPI operations under `/api/v1`:
`POST /calendar-connections/caldav/discover` and `POST /calendar-connections/caldav`.
Discovery returns safe calendar names, capabilities and opaque selection keys, not credentials
or provider URLs. Reconnect uses the existing connection ID and requires you to re-enter
the same server URL and username, plus the replacement password. To change the account
or endpoint, disconnect and add a connection; existing provider copies remain unchanged.
The saved password cannot be retrieved.

## Sync, booking copies and status

Hourmere reads selected calendars for busy intervals. It keeps timed intervals or all-day
dates, hashed event identities and the sync metadata needed for incremental updates; it does
not store fetched event titles, descriptions, attendee lists or raw event bodies. Transparent
and cancelled events do not block time. Declined invitations conservatively remain busy
because the adapter does not independently verify your calendar-user address.

Booking copies use the destination selected for that booking. Changing your default does
not move existing copies. Rescheduling updates the same owned event; cancellation deletes
that event conditionally. External edits are preserved and can require attention. CalDAV
copies do not add attendees, send provider invitations or process RSVPs; Hourmere’s own
booking notifications continue separately.

**Syncing** means the first refresh is pending; **Last synced** reports the last completed
refresh. **Needs attention** can mean credentials, permissions, an unsupported response,
network trouble or a write conflict. It does not mean the calendar is empty. Failed, stale
or incomplete busy data cannot advertise free slots; the usual readiness and availability
troubleshooting rules still apply. Unknown or inaccessible status is shown neutrally.

Use **Reconnect** after an app password expires or is revoked, and check your calendar
choices after discovery. A previously selected calendar missing from discovery stays
unavailable and selected until you explicitly stop checking it on the Calendars page.
A failed reconnect preserves the previous connection. Successful
reconnect also queues bounded recovery of previously pinned booking copies, including
reschedules and cancellations missed while credentials were rejected. Recovery keeps each
original destination and still preserves external edits. It does not restore mappings
removed by disconnect. Retry a
transient error later; ask the operator about a blocked destination or certificate problem.
Do not disable certificate checking to make discovery succeed.

## Disconnect and privacy

**Disconnect** removes the local encrypted credentials, calendar inventory, busy snapshots
and write mappings, and stops further sync and booking writes for that connection. It leaves
already written provider events unchanged. Remove those copies in the provider if needed:
Hourmere can no longer update or cancel them after disconnect. Revoke the app password in
the provider separately if you no longer need it. Disconnecting is not provider revocation.

The server stores the URL, username and password encrypted with AES-256-GCM. Calendar names,
selection, status, resource identities and sync cursors are stored as calendar metadata.
Only owner-scoped safe metadata is returned; passwords and provider responses are not logged.
Protect database backups and the encryption key separately. Losing the key requires
reconnection; changing the key alone is not a supported rotation procedure.

## Known limitations

- Real iCloud, Nextcloud and Fastmail accounts have not been accepted. The iCloud preset
  does not bypass cross-origin credential protection. Only exact operator-approved origins
  may receive credentials; an Apple-looking hostname or returned XML link is not trusted.
- Only the first discovered calendar home is used. Discovery privileges are advisory;
  permissions can change before a read or write.
- Recurring events require server-side expansion. Unexpanded recurrence, unknown/custom
  time zones and ambiguous floating times fail the refresh instead of being ignored.
- No calendar creation, sharing management, CardDAV, tasks, attachments, provider push,
  RSVP processing or scheduling inbox/outbox delivery is implemented.
- Authentication is Basic with a password over verified HTTPS. Other authentication schemes
  and per-connection certificate bypasses are unsupported.
- Public connections use dotted DNS names and HTTPS on port 443. The public hostname
  policy excludes `.local`, `.internal`, `.localhost`, `.home.arpa`, `.service.arpa`, `.alt`,
  `.test`, `.example`, `.invalid` and `.onion`. An eligible private server under one of
  these suffixes requires an operator exception.

## 中文：连接与限制

在 **日历 → 连接 CalDAV** 中选择 iCloud、Nextcloud、Fastmail 或其他服务器，填写
HTTPS 地址、用户名和应用专用密码。iCloud 需要双重认证和应用专用密码；不要填写
Apple 主密码或验证码。Nextcloud 保留安装子目录，使用实例提供的 DAV 地址；Fastmail
使用完整用户名和有日历权限的应用密码，Basic 套餐不提供 CalDAV。

先发现日历，再明确选择用于检查冲突的日历及一个可写的预约目标（也可不写回），最后
保存。发现本身不保存凭据；保存时会重新检查。目标日历不必同时用于冲突检查。新发现
的日历不会自动启用。等待首次同步成功后再依赖可预约时间。

仅本人有效浏览器会话可连接、重连和更改 CalDAV 设置；团队管理员不能操作别人的连接。
MCP、CLI 和 API 密钥不接收提供商密码。重连需要重新填写原地址、原用户名及新密码；
更换账号或地址需先断开再新增。此前选中但发现时已消失的日历仍保留为不可用，需在
日历页明确取消冲突检查。旧密码
不会回显。失败的重连保留原配置；成功重连会分批恢复已有固定目标的预约写回，
包括认证失败期间遗漏的改期和取消，仍保留外部修改，不恢复断开时删除的映射。

Hourmere 加密保存服务器地址、用户名和密码，只保留忙碌时间、事件身份哈希及同步元数据，
不保存读取的事件正文、标题或参会者。预约写回不发送提供商邀请，也不处理 RSVP。改期
更新同一事件，取消有条件地删除；外部修改会保留。更换默认目标不会移动已有预约副本。

“正在同步”“上次同步”和“需要处理”用于说明状态；未知、错误或权限不足不表示没有
日历。失败、过期或不完整的忙闲数据不会被当成空闲。断开连接会删除本地凭据、日历及
同步数据，停止后续同步和写回，但保留提供商中已写入的事件；需要时自行删除，并在
提供商处撤销应用密码。断开后 Hourmere 无法继续更新或取消那些副本。

**尚未完成真实账号验收。** 自动化测试仅使用模拟服务器。iCloud 分片域名必须由运营者
逐个批准；私有 Nextcloud 地址需要运营者例外设置，仍须验证 TLS 证书。仅使用首个日历
主目录；服务器须展开重复事件，无法解释的时区或重复规则会使同步失败。暂不支持日历
创建、共享管理、任务、附件、推送及 RSVP。自托管功能相同，不设托管服务付费门槛。

公网连接使用带点的 DNS 名称和 HTTPS 443 端口。`.local`、`.internal`、`.localhost`、
`.home.arpa`、`.service.arpa`、`.alt`、`.test`、`.example`、`.invalid` 和 `.onion`
不适用于公网连接。这些后缀下符合条件的私有服务器需要运营者配置例外。
