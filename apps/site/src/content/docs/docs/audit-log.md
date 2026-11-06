---
title: Audit log
description: Management events recorded for every Hourmere instance.
---

Hourmere records audit events for account, membership, API-key, OAuth, booking
management and event-type changes on every self-hosted and Cloud instance.
There is no enterprise-plan requirement.

**The audit log is recorded but not yet viewable.** The query UI, REST, MCP and CLI
read APIs, export and retention settings are planned separately. No automatic
retention cleanup runs yet.

Events identify the organization, time, actor, credential used, action, target and
request. Agent actions retain the API-key ID and scope; OAuth actions retain the
client and grant IDs. Events and the recorded change share a database transaction:
if the event cannot be written, the change fails too.

The journal does not copy secrets, tokens, passwords, raw emails, invitee answers,
IP addresses or user agents. Public invitee actions retain entity IDs only.

## 中文说明

每个自托管和 Cloud 实例都会记录账户、成员、API 密钥、OAuth、预订管理和活动类型的审计事件，无需企业套餐。

**审计日志已开始记录，但暂时无法查看。** 查询界面、REST、MCP 和 CLI 读取接口、导出及保留期限设置将另行提供。目前不会自动清理历史记录。

事件记录组织、时间、操作者、所用凭据、操作、目标和请求标识。代理操作保留 API 密钥标识及权限范围；OAuth 操作保留客户端和授权标识。事件与业务变更在同一数据库事务中提交，记录失败时业务变更也会失败。

日志不复制密钥内容、令牌、密码、原始邮件、受邀者回答、IP 地址或浏览器标识。公开预约操作仅保留相关实体标识。
