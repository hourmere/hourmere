---
title: SCIM provisioning
description: Connect an identity provider to provision team users and mapped child-team groups.
---

SCIM 2.0 lets an identity provider (IdP) manage a team's directory entries and mapped
group rosters. Every Hourmere installation, including self-hosted instances, has the same
feature without a subscription or license. SCIM governs provisioning. [SSO](/docs/sso)
governs sign-in.

## Connect your identity provider

1. In a team space, open **Settings → SCIM provisioning tokens**. A team owner can
   create or rotate a token. Owners and admins can list or revoke tokens.
2. Configure the IdP's SCIM 2.0 connector to use
   `https://<hourmere-host>/scim/v2/<organization-id>` and bearer authentication.
   Use the team UUID, available under **Settings → SCIM team mappings**, and keep the
   token in the IdP's protected credential configuration.
3. Test the connection. An authenticated `GET /ServiceProviderConfig` relative to the
   base URL should return 200 with PATCH and filtering supported. Test a pilot user
   before assigning a larger roster. Use `userName` for matching users.
4. To sync a Group, first link its exact, case-sensitive directory `externalId` to an
   existing child team in **Settings → SCIM team mappings**. The current owner of each
   team must approve the same request with fresh proof in their own team. Assign the
   Group in the IdP after the link is in place.

A provisioning token authenticates only to its own organization's SCIM URL. The
complete value appears once, after creation or rotation. Keep it out of URLs, support
tickets, screenshots, shell history and proxy or monitoring logs. Use HTTPS with a
stable public URL. If you restrict source addresses at your reverse proxy, configure
Hourmere to trust forwarded client addresses only from that proxy.

## Tested providers

| Provider | Evidence |
| --- | --- |
| Keycloak 26.8.2 with the Shebang Labs outbound SCIM plugin v0.1.1 | A pinned local fixture with synthetic identities exercised User creation and updates, suspension, reactivation, retirement and Group roster changes. The suite also covers credential rotation and recovery. Some checks, including Group PUT, use direct Hourmere requests. |
| Okta | Synthetic HTTP fixtures replay User GET and full PUT. A live tenant has yet to be tested. |
| Microsoft Entra ID | Synthetic HTTP fixtures cover scheduled and legacy on-demand User PATCH and Group member-removal variants. A live tenant has yet to be tested. Use `userName` matching. |
| Google Workspace and other connectors | Untested. Validate the connector with a pilot before assigning a production roster. |

The [local lifecycle acceptance matrix](https://github.com/hourmere/hourmere/blob/main/docs/scim.md#local-lifecycle-acceptance)
lists the exact requests exercised by the Keycloak fixture.

## Membership and Groups

- An active User with an eligible work address can receive an invitation. The
  person proves control of their verified mailbox and own account to claim the
  membership. Instance signup policy applies. Claims expire
  after 48 hours. Some existing accounts require OIDC linking or re-admission
  proof instead of an invitation.
- Deactivation blocks managed team access and revokes the member's team
  sessions, API keys and MCP OAuth grants. User DELETE also retires the SCIM
  resource. The person's account, personal space, other teams and booking
  history are preserved. Reactivation can restore team access after applicable
  blockers are cleared. Affected team credentials must be created again.
- Deactivating an unlinked User pauses acceptance of its pending SCIM invitation.
  Deleting the User cancels pending SCIM invitations for unfinished claims. Changing
  or clearing the work address invalidates its pending claim and blocks acceptance
  through its SCIM invitation. An administrator can independently issue or renew an
  invitation under the team's usual rules.
- Groups manage only the directory-sourced roster of one explicitly mapped child
  team. Nested groups and role mapping are unsupported. Group DELETE removes its
  managed roster and keeps the child team, manual members and booking history.
  Reassign hosted event types and unfinished bookings in the child before removing
  a member whose departure would affect them.
- If a child owner promotes a directory-managed member to admin, a parent
  directory request to deactivate or DELETE that User fails in full with SCIM
  403 `mutability`. Other memberships and the parent User stay as they were.
  The child owner can resolve the role through ordinary team administration
  before the IdP retries the whole request.
- The child team's [audit log](/docs/audit-log) shows directory roster additions,
  removals, suspensions, reactivations and team credential revocations. It
  identifies the child membership and the SCIM system actor. The log omits
  directory attributes and parent credential identifiers.

## Invitations and initial sync

The invitation says it was sent by the identity provider on behalf of the team. The
verified owner who backs the invitation determines its language through their profile
preference. The audit log identifies the team's SCIM connection for invitation issuance
and cancellation by provisioning.

- Each team can queue 60 SCIM invitation emails per rolling hour and 240 per rolling
  24 hours, shared across its provisioning tokens. App invitations and resends use
  the team's existing app invitation limits and the administrator's own budget.
- The SCIM recipient cap counts requests within the team. Its defaults are five per
  hour and 20 per day for one address. App invitations count app requests across
  teams and SCIM requests from their own team. An instance-wide ceiling across
  all teams and both sources limits aggregate abuse. This ceiling is four times
  the configured recipient limits, 20 per hour and 80 per day by default.
- App and SCIM invitations share the team cap of 100 unexpired pending invitations
  and the instance-wide SMTP attempt budget. Stagger a large initial sync and
  honor the `Retry-After` header on 429. Pending capacity returns as invitations
  are accepted, canceled or expire.

## Known limitations

- Filters accept one quoted equality comparison on Users' `userName` or
  `externalId`, or on Groups' `displayName` or `externalId`. Pages have at most 100
  entries. Bulk operations, `/.search`, sorting, password changes and ETags are
  unsupported. All discovery and resource requests require a provisioning token.
- Each process limits requests to 120 per minute per source, 90 per authenticated
  credential and 120 per organization. Overlapping secrets share a credential budget.
  A 429 includes `Retry-After`. Honor it before retrying.

## Rotate and revoke

A team can have at most 10 active tokens. Rotation preserves the same provisioning
connection and resource IDs. The UI keeps the previous secret usable for one hour.
The browser-session REST operation accepts an overlap of 0–86,400 seconds. Use zero
for immediate cutover. Verify the replacement in the IdP before the old value
expires. A second rotation waits until the current overlap ends.

Revocation disables both values of a rotated token immediately. If a token may have
leaked, revoke it and create a new one. Last-use time records successful credential
authentication, which can precede a failed provisioning operation. Backups retain
only token hashes. Review restored tokens and revoke or rotate them before allowing
provisioning traffic after a restore.

## Rollback drill

1. Pause provisioning in the IdP and leave its assignments in place. Removing
   assignments before pausing can trigger deactivation or deletion. If you also
   need to freeze all new admissions, cancel outstanding invitations in Hourmere.
   Invitations with a live directory claim wait for provisioning to resume.
   Ordinary invitations can still admit members.
2. Set `SCIM_PROVISIONING_ENABLED=false` in the deployment environment and recreate
   every app and separate worker process with the same setting. With the bundled
   Compose setup, update the value in the private `.env` and run
   `./scripts/compose-up.sh -d --wait` with the same Compose overlays. Unset any
   exported value that would override `.env`. An unset or empty value enables SCIM.
   Explicit `0` and `off` also disable it. An invalid value stops startup.
3. Verify that `GET` requests to `/ServiceProviderConfig`, `/ResourceTypes`,
   `/Schemas`, `/Users` and `/Groups` relative to the SCIM base URL all return the
   same SCIM 404, with or without a previously valid bearer. Owners and admins can
   still list and revoke provisioning tokens. Creation and rotation are disabled.
4. Check a previously active and a previously suspended test member in Hourmere,
   including a mapped child team. Provisioned records, mappings, memberships and
   audit history are kept. Previously suspended members remain blocked, and stored
   mailbox admission blockers still apply. Sessions, keys and grants revoked during
   deprovisioning stay revoked. Directory-only editing restrictions on profiles
   and mapped team names may pause while the switch is off.
5. To resume, remove the explicit off value, or set it to `true`, and recreate
   the same processes. Unrevoked provisioning tokens become usable again, subject to
   their original overlap deadlines. Revoke old tokens before re-enabling if they
   should remain unusable. Run the IdP connection and pilot checks before resuming
   its scheduled sync.

For more detail, see [instance configuration](/docs/configuration),
[the supported protocol subset](https://github.com/hourmere/hourmere/blob/main/docs/scim.md#protocol-surface)
and the [offline mapping recovery runbook](https://github.com/hourmere/hourmere/blob/main/docs/scim.md#offline-mapping-recovery-runbook).

## 中文说明

SCIM 默认开启，自托管实例无需订阅。团队所有者在「设置 → SCIM 预配令牌」中创建令牌，
并在身份提供商的 SCIM 2.0 连接器中使用团队专属地址
`https://<hourmere-host>/scim/v2/<organization-id>`。请先用少量测试用户验证连接。
同步群组前，父团队和子团队的所有者须分别批准对同一个群组 `externalId` 的映射。

SCIM 邀请邮件以身份提供商代表团队的名义发出，语言沿用邀请所关联的已验证所有者的语言偏好。
审计日志记录发出或取消邀请的 SCIM 连接。每个团队在滚动一小时内可安排 60 封 SCIM 邀请邮件，滚动 24 小时内可安排 240 封，
团队所有预配令牌共用此额度。应用内邀请和重发使用独立的管理者额度。SCIM 邀请的收件人限额按团队计算，默认同一地址
每小时 5 封、每天 20 封。应用内邀请的收件人限额统计所有团队的应用内邀请和本团队的 SCIM 邀请。为限制滥用，
所有团队的邀请另有实例级收件人上限，为配置值的四倍，默认每小时 20 封、
每天 80 封。初次同步人数较多时请分批进行，遇到 429 时遵循 `Retry-After`。

目录停用成员时会暂停其受管团队访问，并撤销相关会话、API 密钥和 MCP OAuth 授权。
如果子团队所有者已将该受管成员提升为管理员，父目录对该用户的停用或删除会整体返回 403，
父子团队的状态均保持原样。子团队的审计日志会记录受管成员和访问凭证的变更。

需要回退时，先暂停身份提供商的同步，再将所有应用和后台进程的
`SCIM_PROVISIONING_ENABLED` 设为 `false` 并重建进程。验证发现、用户和群组入口都返回相同的 404。
空值表示开启。用户、群组以及映射记录会保留，暂停的成员仍无法访问，已撤销的凭证不会恢复。
如果还需暂停所有新成员加入，请取消未处理的邀请。关闭 SCIM 后，会完成有效目录认领的邀请须等待预配恢复，
普通邀请仍可接受。团队所有者和管理员仍可查看或撤销预配令牌，尚未撤销的令牌在重新启用后可以继续使用。
