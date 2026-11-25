---
title: Single sign-on
description: Enable organization single sign-on with OIDC or SAML, set up a team identity provider, and recover access when sign-in fails.
---

Organization single sign-on lets a team's members sign in to that team through the team's
OpenID Connect (OIDC) or SAML 2.0 identity provider, and lets the team require it. It is
available to every installation, including self-hosted ones, without a subscription or
license requirement. **Both protocols are off by default.**

## Turn it on

Set an encryption key and turn on the protocols your teams need. Use the same settings
on web and worker, then restart both.

| Variable | Value |
|---|---|
| `SSO_OIDC_ENABLED` | `true` enables OIDC. Empty or unset follows the release default, currently off. `false` keeps it off. Other values stop startup. |
| `SSO_SAML_ENABLED` | `true` enables SAML. Empty or unset follows the release default, currently off. `false` keeps it off. Other values stop startup. |
| `SSO_ENCRYPTION_KEY` | An independent 32-byte base64 key (`openssl rand -base64 32`) that seals identity provider configuration. Keep it stable and backed up privately: without it saved providers cannot be read. |

Hourmere also needs a canonical HTTPS `PUBLIC_URL` and working SMTP, because every first
enrollment and every sensitive change is confirmed through the member's own mailbox. An
identity provider on a private network, or on a port other than 443, must be listed in
[`SSO_PRIVATE_TARGETS`](/docs/configuration#private-identity-providers) when Hourmere
fetches data from it. See the [configuration reference](/docs/configuration).

`GET /api/v1/instance` reports the effective state of each protocol as `ssoOidcEnabled`
and `ssoSamlEnabled`. A fresh `.env` from `scripts/setup.sh` leaves both switches empty.
Compose passes through those empty values. A deployment with an older `.env` that lacks
`SSO_SAML_ENABLED` also leaves SAML off.

## Set up a team

A team owner or administrator opens **Settings → Single sign-on** in the team's space.

1. In **SSO domains**, generate a challenge for the team's exact email domain, publish the
   TXT record it shows in DNS, and choose **Verify domain**. Hourmere rechecks the record
   regularly; a domain whose record disappears stops authorizing new sign-ins.
2. In **Identity providers**, create a provider and associate the verified domain.

   - For OIDC, enter the issuer, client ID and client secret. In the identity provider,
     register the exact redirect URL `https://<your Hourmere host>/api/auth/sso/callback/<providerId>`.
   - For SAML, enter the IdP entity ID, sign-in URL and signing certificates, paste IdP
     metadata XML, or import IdP metadata by HTTPS URL. Use the Hourmere service provider
     metadata in the provider form to register the exact ACS URL and stable entity ID in
     the IdP. Configure it to sign assertions with a supported certificate. In Keycloak,
     enable **Sign assertions**.

   The CLI command `sso providers list` and `GET /api/v1/team/sso/providers` list the provider ID.

3. Choose **Test provider**. After a passing test of the current revision, a team owner can
   enable the provider. Editing a provider creates a new revision that needs a new test.
4. Give members the team's sign-in link. For OIDC use
   `https://<your Hourmere host>/sign-in?sso=<providerId>`. For SAML append `&saml=1`.
   Members choose their provider through this link.

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

### Repair a SAML provider during recovery

An enrolled owner signs in using their usual Hourmere method and opens **SSO recovery**.
Select the enforced team and verify your Hourmere mailbox. Open the SAML provider to
enter replacement signing certificates or import the updated IdP metadata. Saved
certificates and metadata are write-only. When entering certificates manually, provide
the complete list that should be trusted. For a planned rotation, include both the old
and new certificates during the overlap, then remove the old certificate after the IdP
switches. Each changed revision needs its own test.

Save the repair. Verify your mailbox again to test the saved revision, and complete
the test in the new tab. Return to recovery and verify once more to enable the tested
revision. Each write uses one recovery grant. If SAML is disabled on the instance, an
enrolled owner can still inspect the configuration and turn off the team's SSO requirement.

## What off means

Turning either protocol off preserves the team's stored SSO requirement. For a team
that already has SSO configuration:

- Requests that add trust through the disabled protocol return `404 sso_disabled`. This
  includes sign-in, callbacks, SAML ACS and metadata, provider creation, editing, tests
  and enabling, account linking, step-up and delegation binding. Starting enforcement
  requires a usable provider for an enabled protocol. Domain challenges and verification,
  just-in-time admission and recovery enrollment require at least one enabled protocol.
- Existing browser proofs and delegations for the disabled protocol are suspended. They
  work again if it is enabled before their existing deadline. Members of an enforcing team
  need a proof from an enabled provider to access that team. Personal spaces still work.
- Reads, recovery and everything that removes trust stay available, each with its usual
  mailbox confirmation: SSO recovery, turning the requirement off, disabling or deleting a
  provider, deleting a domain, unlinking, retiring a member's link and revoking a
  delegation. On a team that requires SSO, an enrolled owner uses SSO recovery first.
- Domain rechecks keep running, so verification state is current when the setting returns.

A team that never configured SSO sees no SSO controls while both protocols are off.

## Limitations

- SAML sign-in starts at Hourmere. The IdP must send a signed, unencrypted assertion.
  Linking uses a persistent NameID by default or a configured immutable subject attribute.
- Microsoft Entra ID does not emit `auth_time` unless configured as an optional claim;
  without it, every fresh verification at Entra also asks for mailbox confirmation.
- Signing out of the identity provider leaves the Hourmere session active until it expires.
  To revoke team access after someone leaves the identity provider, remove the member in
  Hourmere or configure directory deprovisioning through [SCIM](/docs/scim).

REST, MCP and CLI coverage is listed in the [API key](/docs/api-keys) and
[MCP](/docs/mcp) scope tables; the full design is in
[docs/sso.md](https://github.com/hourmere/hourmere/blob/main/docs/sso.md).

## 中文说明

组织单点登录的 OIDC 和 SAML 默认关闭。实例运营者可分别设置 `SSO_OIDC_ENABLED=true` 或
`SSO_SAML_ENABLED=true`，并配置独立的 `SSO_ENCRYPTION_KEY`（32 字节 base64）。网页和后台进程
使用相同的设置，重启后生效。留空或不设置时使用版本默认值（目前为关闭），`false` 明确关闭，
其他取值会阻止启动。旧版 `.env` 缺少 `SSO_SAML_ENABLED` 时，SAML 仍保持关闭。

团队所有者或管理员在团队空间的**设置 → 单点登录**中验证域名、创建并测试身份提供方。SAML
支持手动填写身份提供方资料和签名证书、粘贴元数据 XML 或通过 HTTPS 网址导入元数据。使用
Hourmere 的服务提供方元数据在身份提供方登记准确的 ACS 网址和固定的实体 ID，并开启断言签名。
由所有者启用通过测试的版本后，把登录链接发给成员。SAML 登录链接末尾加上 `&saml=1`。
成员在**设置**的**你的团队登录方式**中关联或解除关联账号。
所有者可在**强制单点登录**中要求团队使用单点登录，前提是至少一位所有者已完成恢复登记。

关闭任一协议时，团队已保存的强制要求继续生效。使用该协议登录、关联或添加配置会返回
`404 sso_disabled`。该协议的浏览器证明和委托会暂停，在各自期限内重新启用协议后继续有效。
读取、恢复以及停用或删除身份提供方、删除域名、解除关联、撤销委托、关闭强制等操作保持可用。
从未配置过单点登录的团队在两种协议都关闭时看不到相关选项。

已登记的所有者可用原有方式登录，在**单点登录恢复**中选择团队并验证邮箱。SAML 启用时，
可为提供方提交替换证书或导入更新的元数据。已保存的证书和元数据仅供写入。保存修复、测试
新版本和重新启用各需一次邮箱验证。SAML 关闭时，仍可查看配置和关闭团队的强制要求。
