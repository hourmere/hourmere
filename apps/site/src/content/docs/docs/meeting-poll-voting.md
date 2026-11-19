---
title: Voting in a meeting poll
description: Verify your email, choose possible meeting times, and understand poll privacy.
---

The public voting page is implemented, but **poll creation is not available yet** in
Hourmere. There is no setting that enables creation. Until creation is released, links
on a normal installation show the same unavailable page. This guide describes the voting
flow for when a poll exists; it does not offer a way to create one.

## Open and verify your link

You do not need an Hourmere account. A public poll link lets you enter your name, email
address and time zone to request verification. An accepted request says to check your
email, whether or not that address is already registered. It does not promise delivery.
A full poll gives the same full message for every address.

Follow the emailed link, then explicitly confirm your email. Opening a link alone never
verifies your address, votes or unsubscribes. A host invitation has its own private voter
link. Keep your voter link private: anyone who holds it can act as you within that poll.
If you lose access, use recovery with the poll ID and your email. Recovery always gives
the same response and only sends a link to an eligible existing voter; it does not enroll
someone new or extend the deadline. Email budgets and cooldowns can prevent delivery.

## Choose your times

The page shows each candidate and the voting deadline in your selected time zone. Date
and UTC-offset labels distinguish times across daylight-saving changes, including repeated
hours. Switching time zones only changes the labels; your choices still refer to the same
instants, even when the local calendar day changes.

Choose **Yes**, **If need be** or **No** for every time, answer any required questions,
and give consent before saving. A saved ballot can be changed while voting is open.
Voting does not reserve a time or guarantee that you will attend: the host may select a
subset of consenting voters who chose yes or if need be. The designated booker can manage
the whole meeting. A resulting calendar invitation may reveal attendees to one another.

If a ballot has changed in another tab, reload and review it before saving again. After
an uncertain save, check the current ballot instead of blindly repeating the submission.
Rate-limit, validation and loading errors do not mean that the poll is missing.

## Withdraw, recover and stop reminders

Withdrawal removes your votes and question answers from the poll and opts you out of
further poll email. Your contact details remain for uniqueness and possible reactivation.
While voting is open, the same voter link can reactivate your participation by submitting
a new complete ballot with renewed consent, if a place is available. Recovery does not
send a link to a withdrawn voter, so keep that original link.

A reminder email's unsubscribe link opens a separate confirmation page. Confirming stops
reminders without changing your ballot or granting access to it. It does not withdraw you
or stop every kind of poll email. Requests already accepted for delivery cannot be recalled.

After voting closes, a valid retained voter link can still show the safe poll details and
your prior ballot, but cannot change them. Invalid, expired verification, removed and revoked links use
one neutral unavailable message without revealing which case applies.

## What others can see

- **Private polls:** other voters cannot see your name, email, answers or choices, and
  no aggregate totals are shown.
- **Aggregate polls:** verified voters can see separate yes, if-need-be and no totals for
  each time. With a small group, totals can reveal someone else's choices; this is not
  anonymity. The voting page hides totals while you are withdrawn. The public API still
  permits a retained verified withdrawn credential to read aggregate totals.
- The host and authorized managers can see the private roster, ballots, answers and
  verification or withdrawal state. Other voters never receive that roster.

Private links carry their credential after the URL's `#`, not in query parameters. The
page sends it in a request body and does not put it in browser storage. Do not paste these
links into analytics, logs or support tickets. Poll pages are not an embeddable booking
widget. Display language is available in English, 简体中文, Deutsch, Français, Español and
Português (Brasil).

## 中文说明

公开投票页面已实现，但 **Hourmere 尚未提供创建会议投票的功能**，也没有可以开启创建的
设置。在创建功能发布前，正常部署中的链接均显示统一的不可用页面。

投票不需要 Hourmere 账号。通过公开链接填写姓名、邮箱和时区后，页面会统一提示检查
邮件，不透露该邮箱是否已登记，也不保证邮件送达。打开邮件链接不会自动验证或投票；
需要明确确认邮箱。找回功能使用投票 ID 和邮箱，仅向符合条件的已有投票者重发原链接，
不会新增报名、轮换链接或延长截止时间。

请为每个时间选择“可以”“必要时可以”或“不可以”，填写必填问题并同意参加后保存。
切换时区只改变日期、时间和 UTC 偏移显示，不会改变所选时段。截止前可修改选票或撤回；
撤回会清除选票和答案并停止后续投票邮件，但保留用于去重和重新参加的联系信息。
保留原链接可在截止前重新提交完整选票并再次同意参加，前提是仍有名额。
找回功能不会给已撤回的投票者发送链接。邮件中的提醒退订链接需要明确确认，只停止提醒，
不撤回选票，也不停止所有类型的投票邮件。

私密投票不向其他投票者展示姓名、邮箱、答案、选项或总数。汇总投票仅向已验证投票者
展示各时段的三类票数；人数较少时仍可能推断他人的选择，因此汇总不等于匿名。
页面在撤回后隐藏汇总，但公开 API 仍允许持有有效已验证撤回凭证的人读取汇总。
主持人及有权管理的人员可查看名单、选票和答案。投票并不预留时间，也不保证入选；
主持人可选择部分同意参加的投票者，指定的预约人可管理整场会议，最终日历邀请可能向
参会者展示其他参会者。

有效链接在投票关闭后可只读查看安全信息及自己的旧选票。无效、过期、移除及撤销的链接
显示统一的不可用信息。链接中的私密凭证只放在 `#` 后并通过请求正文提交，不写入浏览器
存储。请勿转发私人投票链接或将其放入日志、分析工具及支持工单。
