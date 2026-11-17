[Notifications and background jobs](https://hourmere.com/docs/notifications).

If the original inviter leaves or is removed from the team, their pending invitations are
no longer valid. Neither resend nor the expired-row replacement action can reuse them:
both refuse with `INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION`.
Acceptance uses the same error code.
Native recipient invitation discovery omits these rows. They grant no signup exception:
an otherwise ineligible address receives no sign-in email and cannot create an account.
A current owner/admin must cancel any old pending invitation and send a fresh invitation
in their own name through the invite form.
The administrator list shows **No longer valid**, with derived `invalidReason: "inviter_left"`;
cancellation remains allowed. Demotion while the inviter remains a member leaves validity
unchanged. These checks do not rewrite the invitation's stored lifecycle.

Offline SSO domain retirement durably records notices for the retired claim's team owners.
The maintenance command sends them through configured SMTP; failed delivery can be retried
with its `notify` operation. Recipients must still be verified owners when delivery runs.
There is no notice to the requesting team or caller-supplied mailbox, and periodic
recheck failures do not send mail. See the [operator runbook](sso.md#domain-lifecycle-operations).

SSO 域名运维退役会为旧声明团队的所有者保存通知，并通过已配置的 SMTP 发送；失败后可用
`notify` 重试。发送时仍须是邮箱已验证的所有者。不会向请求团队或调用者指定的地址发送，
定期复查失败也不发送邮件。
