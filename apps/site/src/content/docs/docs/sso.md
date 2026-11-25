---
title: Single sign-on (OIDC)
description: Turn on organization OIDC single sign-on, set up a team's identity provider, and understand what stays available when it is off.
---

Organization single sign-on lets a team's members sign in to that team through the team's
own OpenID Connect (OIDC) identity provider, and lets the team require it. It is available
to every installation, including self-hosted ones, without a subscription or license
requirement. **It is off by default.** SAML is being built and is not available yet.

## Turn it on

The instance operator sets two variables and restarts the server (web and worker alike):

| Variable | Value |
|---|---|
| `SSO_OIDC_ENABLED` | `true`. Empty or unset follows the release default, which is off for now; `false` keeps it off; any other value stops startup. |
| `SSO_ENCRYPTION_KEY` | An independent 32-byte base64 key (`openssl rand -base64 32`) that seals identity provider configuration. Keep it stable and backed up privately: without it saved providers cannot be read. |

Hourmere also needs a canonical HTTPS `PUBLIC_URL` and working SMTP, because every first
enrollment and every sensitive change is confirmed through the member's own mailbox. An
identity provider on a private network, or on a port other than 443, must be listed in
[`SSO_PRIVATE_TARGETS`](/docs/configuration#private-identity-providers). See the
[configuration reference](/docs/configuration) for all three settings.

`GET /api/v1/instance` reports the effective state as `ssoOidcEnabled`; `ssoSamlEnabled`
is always `false` for now.

## Set up a team

A team owner or administrator opens **Settings → Single sign-on** in the team's space.

1. In **SSO domains**, generate a challenge for the team's exact email domain, publish the
   TXT record it shows in DNS, and choose **Verify domain**. Hourmere rechecks the record
   regularly; a domain whose record disappears stops authorizing new sign-ins.
2. In **Identity providers**, create an OIDC provider with the issuer, client ID and client
   secret from your identity provider, and associate the verified domain. Then register
   `https://<your Hourmere host>/api/auth/sso/callback/<providerId>` as the redirect URL
   at your identity provider. The provider ID is listed by the CLI command
   `sso providers list` and by `GET /api/v1/team/sso/providers`.
3. Choose **Test provider**. After a passing test of the current revision, a team owner can
   enable the provider. Editing a provider creates a new revision that needs a new test.
4. Give members the team's sign-in link,
   `https://<your Hourmere host>/sign-in?sso=<providerId>`. The sign-in page never looks a
   provider up by email address or domain.

Changes to SSO settings ask you to verify your identity first, through a link sent to your
Hourmere mailbox or, once the team requires SSO, through a fresh sign-in at the identity
provider.

## Members

- **Sign in:** open the team's sign-in link and choose **Sign in with single sign-on**.
  Your personal space keeps its usual sign-in methods.
- **Link an existing account:** sign in as usual, switch to the team's space, open
  **Settings** and choose the provider under **Your team sign-in**. You confirm your
  Hourmere mailbox, sign in at the identity provider, and confirm the link.
- **Unlink:** use the same section and confirm your Hourmere mailbox again.

New people join by invitation unless the team chooses **Just-in-time admission** in
**SSO enforcement**, which needs a verified team domain.

## Require SSO

In **SSO enforcement** a team owner can require SSO for the team. This needs an enabled,
owner-tested provider with a verified domain and at least one owner who has accepted
**recovery enrollment**. Once required:

- team data is available only to browser sessions that signed in through the team's
  provider; personal spaces are unaffected;
- API keys and connected apps (MCP OAuth) in the team's space need an **SSO delegation**,
  which their owner binds under **API keys** or **Connected apps** after a fresh SSO
  sign-in, and which expires;
- an enrolled owner can use **SSO recovery** from Settings to turn the requirement off
  without the identity provider, after confirming their mailbox. A self-hosting operator
  can also turn it off with the
  [operator recovery command](https://github.com/hourmere/hourmere/blob/main/docs/sso.md#operator-recovery-runbook).

## What off means

Turning `SSO_OIDC_ENABLED` off (or leaving it unset) **never lifts a team's stored SSO
requirement**. For a team that already has SSO configuration:

- Everything that adds trust stops and answers `404 sso_disabled`: sign-in, callbacks,
  provider creation, editing, tests and enabling, account linking, step-up, delegation
  binding, new domain challenges and verification, just-in-time admission, recovery
  enrollment, and turning the requirement on.
- Existing browser proofs and delegations are suspended, not revoked. They work again if
  the setting returns before their own deadline, which nothing extends. Meanwhile members
  of a team that requires SSO cannot reach that team; their personal spaces still work.
- Reads, recovery and everything that removes trust stay available, each with its usual
  mailbox confirmation: SSO recovery, turning the requirement off, disabling or deleting a
  provider, deleting a domain, unlinking, retiring a member's link and revoking a
  delegation. On a team that requires SSO, an enrolled owner uses SSO recovery first.
- Domain rechecks keep running, so verification state is current when the setting returns.

A team that never configured SSO sees no SSO controls while the setting is off.

## Limitations

- OIDC only; SAML is not available yet and no setting enables it.
- Microsoft Entra ID does not emit `auth_time` unless configured as an optional claim;
  without it, every fresh verification at Entra also asks for mailbox confirmation.
- Signing out of the identity provider leaves the Hourmere session active until it expires.
  To revoke team access after someone leaves the identity provider, remove the member in
  Hourmere or configure directory deprovisioning through [SCIM](/docs/scim).

REST, MCP and CLI coverage is listed in the [API key](/docs/api-keys) and
[MCP](/docs/mcp) scope tables; the full design is in
[docs/sso.md](https://github.com/hourmere/hourmere/blob/main/docs/sso.md).

## 中文说明

组织单点登录（OIDC）默认关闭。实例运营者设置 `SSO_OIDC_ENABLED=true` 和独立的
`SSO_ENCRYPTION_KEY`（32 字节 base64）并重启后生效；留空或不设置时使用版本默认值（目前为
关闭），其他取值会阻止启动。SAML 仍在开发中，没有可启用它的设置。

团队所有者或管理员在团队空间的**设置 → 单点登录**中验证域名、创建并测试 OIDC 身份提供方，
由所有者启用后把登录链接发给成员。成员在**设置**的**你的团队登录方式**中关联或解除关联账号。
所有者可在**强制单点登录**中要求团队使用单点登录，前提是至少一位所有者已完成恢复登记。

关闭该设置不会解除团队已保存的强制要求：登录、关联、新配置等增加信任的操作返回
`404 sso_disabled`；已有的浏览器证明和委托被暂停而非撤销，在各自期限内重新开启设置后继续
有效；读取、恢复以及停用或删除身份提供方、删除域名、解除关联、撤销委托、关闭强制等降低信任
的操作保持可用。从未配置过单点登录的团队在关闭时看不到任何相关选项。
