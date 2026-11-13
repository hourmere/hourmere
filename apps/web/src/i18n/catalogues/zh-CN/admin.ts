// English semantic keys keep local UI messages language-independent in state.
export const admin = {
  'SCIM provisioning tokens': 'SCIM 预配令牌',
  'Provisioning is not available yet. These tokens prepare your organization for a future SCIM connection.':
    '预配功能尚未开放。这些令牌用于为组织未来的 SCIM 连接做准备。',
  'Tokens only authorize SCIM for this organization. Keep them private.':
    '令牌仅授权访问此组织的 SCIM 服务。请妥善保管。',
  'Could not update provisioning tokens. Check the token list before trying again.':
    '无法更新预配令牌。请先查看令牌列表，再重试。',
  'New provisioning token': '新预配令牌',
  'Copy this token now. It will not be shown again after you dismiss it or leave this view.':
    '请立即复制此令牌。隐藏令牌或离开此视图后，将无法再次查看。',
  'Copy token': '复制令牌',
  'Dismiss token': '隐藏令牌',
  'Provisioning token name': '预配令牌名称',
  'Create provisioning token': '创建预配令牌',
  'Loading provisioning tokens…': '正在加载预配令牌……',
  'Could not load provisioning tokens.': '无法加载预配令牌。',
  'No provisioning tokens.': '暂无预配令牌。',
  'Previous token valid until: {date}': '旧令牌有效期至：{date}',
  'Last used: {date}': '上次使用时间：{date}',
  'Rotate token': '轮换令牌',
  'Revoke token': '撤销令牌',
  'Confirm token change': '确认令牌更改',
  'The old token will remain valid for one hour. Update your identity provider with the new token during this time. You cannot rotate again until the overlap ends.':
    '旧令牌将继续有效一小时。请在此期间将身份提供方中的令牌更新为新令牌。重叠有效期结束前无法再次轮换。',
  'Revoking this token stops access for both the current token and its previous version immediately. This cannot be undone.':
    '撤销后，当前令牌及其上一版本将立即失效。此操作不可恢复。',

  'No-shows': '未出席记录',
  'No-show': '未出席',
  'Only hosts and team administrators can see these marks. No email is sent, and scheduled follow-ups stay unchanged.':
    '这些标记仅供主持人和团队管理员查看。不会发送邮件，已安排的会后消息也不会改变。',
  'Clear no-show for {name}': '清除{name}的未出席标记',
  'Mark {name} as a no-show': '将{name}标记为未出席',
  'Clear no-show': '清除未出席标记',
  'Mark no-show': '标记为未出席',
  'Could not update the no-show mark. Refresh the booking and try again.':
    '无法更新未出席标记。请刷新预约后重试。',
  'No-show mark updated.': '未出席标记已更新。',

  '{0} location options are configured. Manage them through REST, MCP or CLI. Saving other fields keeps these options.':
    '已配置{0}个地点选项。请通过 REST、MCP 或 CLI 管理。保存其他字段会保留这些选项。',
  'Loading logo preview…': '正在加载标志预览…',
  'Logo preview is unavailable.': '暂时无法预览标志。',
  'Saved brand logo': '已保存的品牌标志',

  'Booking page branding': '预约页面品牌设置',
  'Save a logo and primary colour for this space. Applying them to booking pages and emails is not available yet.':
    '为当前空间保存标志和主色。目前尚未应用到预约页面和邮件。',
  'Branding access has not been confirmed.': '尚未确认品牌设置权限。',
  'Only the personal owner or team owners and admins can manage branding.':
    '只有个人空间所有者、团队所有者和管理员可以管理品牌设置。',
  'Manage branding': '管理品牌设置',
  'Loading branding…': '正在加载品牌设置…',
  'Could not load branding.': '无法加载品牌设置。',
  'Enter a colour in #RRGGBB format, or leave it empty to clear it.':
    '请输入 #RRGGBB 格式的颜色，留空即可清除。',
  'Choose a PNG, JPEG or WebP image up to 512 KB. SVG is not supported.':
    '请选择不超过 512 KB 的 PNG、JPEG 或 WebP 图片。不支持 SVG。',
  'Choose a valid PNG, JPEG or WebP image up to 512 KB and 2048 × 2048 pixels. SVG and animated images are not supported.':
    '请选择有效的 PNG、JPEG 或 WebP 图片，大小不超过 512 KB，宽高均不超过 2048 像素。不支持 SVG 和动图。',
  'Edit branding': '编辑品牌设置',
  'Primary colour': '主色',
  'Black or white button text is selected automatically for at least 4.5:1 contrast. Contrast against the white page background is reported separately.':
    '系统会自动选择黑色或白色按钮文字，确保对比度至少为 4.5:1。与白色页面背景的对比度会单独显示。',
  'Brand logo': '品牌标志',
  'A logo is saved for this space.': '此空间已保存标志。',
  'Remove logo': '移除标志',
  'Save branding': '保存品牌设置',
  'Saved colour: {colour}. Button text: {text}. Contrast against white: {ratio}:1.':
    '已保存颜色：{colour}。按钮文字：{text}。与白色的对比度：{ratio}:1。',
  Black: '黑色',
  White: '白色',
  'Branding saved. Booking pages and emails are unchanged.':
    '品牌设置已保存。预约页面和邮件暂不受影响。',
  'Event type filter': '按活动类型筛选',
  'All event types': '所有活动类型',
  'Saved event type — details unavailable': '已保存的活动类型（详情暂不可用）',
  'Loading event type choices…': '正在加载活动类型选项……',
  'Could not load event type choices. Your saved filter is unchanged.':
    '无法加载活动类型选项。已保存的筛选条件保持不变。',

  Integrations: '集成',
  'Slack booking notifications': 'Slack 预约通知',
  'Booking created': '预约已创建',
  'Booking cancelled': '预约已取消',
  'Booking rescheduled': '预约已改期',
  'Send event titles, booking IDs, times, status and admin links to Slack. Personal destinations also include the invitee name. Email addresses, custom answers and meeting links are never included.':
    '向 Slack 发送活动标题、预约编号、时间、状态和后台链接。个人接收地址还包含受邀人姓名，不包含邮箱、自定义答案或会议链接。',
  'Loading Slack notifications…': '正在加载 Slack 通知……',
  'Could not load Slack notifications. Only organization owners and admins can manage them.':
    '无法加载 Slack 通知。只有组织所有者和管理员可以管理通知。',
  'Could not update Slack notifications. Check your access and settings, then try again.':
    '无法更新 Slack 通知。请检查权限和设置，然后重试。',
  'No Slack destination yet.': '尚未设置 Slack 接收地址。',
  'Slack rejected this webhook URL, so notifications are paused. Replace the URL, then enable notifications.':
    'Slack 拒绝了此 Webhook 地址，通知已暂停。请先更换地址，再启用通知。',
  'Slack notifications are paused.': 'Slack 通知已暂停。',
  'Slack destination saved.': '已保存 Slack 接收地址。',
  'Slack test message queued. This does not confirm delivery.':
    'Slack 测试消息已加入发送队列。这不代表消息已送达。',
  'Send test message': '发送测试消息',
  'Delete this Slack destination and its delivery history?': '删除此 Slack 接收地址及其发送记录？',
  'Delete Slack destination': '删除 Slack 接收地址',
  'Slack destination deleted.': '已删除 Slack 接收地址。',
  'Configure Slack notifications': '配置 Slack 通知',
  'Enter a Slack webhook URL and choose at least one event.':
    '请输入 Slack Webhook 地址，并至少选择一种事件。',
  'Replacement Slack webhook URL': '新的 Slack Webhook 地址',
  'Slack incoming-webhook URL': 'Slack 传入 Webhook 地址',
  'Use an HTTPS incoming-webhook URL from hooks.slack.com. Keep it private. Leave replacement blank to keep the saved URL.':
    '请使用 hooks.slack.com 的 HTTPS 传入 Webhook 地址，并妥善保密。无需更换时，请将新地址留空。',
  'Events to post': '要发送的事件',
  'Enable Slack notifications': '启用 Slack 通知',
  'Save Slack destination': '保存 Slack 接收地址',
  'Group-seat bookings do not support reschedule requests.': '团体席位预约不支持请求改期。',
  'Use plain text with at most 2000 characters. Tabs and control characters are not allowed.':
    '请使用最多 2000 个字符的纯文本，不可包含制表符和控制字符。',

  'Waiting for the invitee to choose a new time.': '正在等待受邀人选择新时间。',
  'Ask the invitee to choose a new time': '请受邀人选择新时间',
  'The original time stays booked. The invitee can choose another time or cancel. If they do not respond within 48 hours or before the meeting starts, the original booking stays in place.':
    '原时间仍会保留。受邀人可以选择其他时间或取消预约。如果在 48 小时内或会议开始前没有回应，原预约保持不变。',
  'The request is saved. The invitee will receive an email, subject to delivery limits.':
    '请求已保存。受邀人将收到邮件，实际发送受邮件限额约束。',
  'Request reschedule': '请求改期',
  'A new request replaces any previous request for this booking.':
    '新请求会替换此预约之前的改期请求。',
  'Note to the invitee': '给受邀人的留言',
  'Plain text, up to 2000 characters. Included only in the email body.':
    '最多 2000 个字符，仅限纯文本。留言只会出现在邮件正文中。',
  'Use at most 2000 characters for your note.': '留言最多可输入 2000 个字符。',
  'Could not request a new time. {0}': '无法发送改期请求。{0}',
  'Retry the same request': '重试此请求',
  'Send request': '发送请求',

  'Export bookings as CSV': '将预约导出为 CSV',
  'Choose a start-time range of at most 366 days. Current booking filters also apply.':
    '请选择不超过 366 天的预约开始时间范围。导出时同样适用当前的筛选条件。',
  'This file contains personal data. Store and share it carefully.':
    '此文件包含个人数据。请妥善保存并谨慎分享。',
  'CSV times use {zone} and UTC.': 'CSV 中的时间使用{zone}和 UTC。',
  'Bookings starting at or after (UTC)': '预约开始时间不早于（UTC）',
  'Bookings starting before (UTC)': '预约开始时间早于（UTC）',
  'Include UTF-8 BOM for Excel': '包含 UTF-8 BOM，便于 Excel 读取',
  'Could not download CSV. Check the booking range and try again shortly.':
    '无法下载 CSV。请检查预约时间范围，稍后重试。',
  'An export is already running for your account. Wait for it to finish and try again.':
    '你的账户已有导出正在进行。请等待导出完成后重试。',
  'Download CSV': '下载 CSV',

  'Past date overrides ({0})': '过去的特定日期安排（{0}）',
  'Times are in {0}.': '时间均按{0}显示。',
  'This schedule changed in another tab or from an API, MCP or CLI client. Your changes are still here. Review the latest version before applying your draft again.':
    '此日程已在其他标签页中或通过 API、MCP 或 CLI 客户端更改。你的更改仍保留在此页面。请先查看最新版本，再重新应用你的草稿。',
  'Review latest version': '查看最新版本',
  'Latest saved version': '最新保存的版本',
  'Draft applied to the latest version. Save changes to submit it.':
    '草稿已应用到最新版本。请点击保存更改以提交。',
  'Apply my draft to this version': '将我的草稿应用到此版本',
  'Applying your draft replaces the latest weekly hours and date overrides. Review both before saving.':
    '应用你的草稿将替换最新的每周时间段和特定日期安排。保存前请对照查看最新版本和你的草稿。',
  'Could not load the latest version. {0}': '无法加载最新版本。{0}',
  'Copy hours from {0}': '复制{0}的时段',
  'Copy to…': '复制到…',
  'Replace the selected days with these hours, including unavailable days. Changes are saved with Save changes.':
    '将所选各天的时段替换为该天的时段（不可用的日子也会照搬）。点击“保存更改”后生效。',
  Weekdays: '工作日',
  'All days': '全选',
  'Apply copy': '确认复制',
  'Each date can have only one override.': '每个日期只能有一项特定日期安排。',
  'Date overrides replace weekly hours on that date. Save changes applies every change on this page.':
    '特定日期安排会替换当天的每周时间段。点击“保存更改”即可保存本页所有更改。',
  'No date overrides.': '暂无特定日期安排。',
  'Date override {0}': '特定日期安排{0}',
  'Save schedule details, weekly hours and date overrides together with Save changes.':
    '点击“保存更改”，统一保存日程详情、每周时间段和特定日期安排。',

  Imported: '已导入',
  'the original scheduling system': '原预约系统',

  'The saved location options cannot be changed here. Keep the location unchanged and try again.':
    '无法在此处更改已保存的地点选项。请保留原地点后重试。',
  'Checking waitlist management access…': '正在检查候补名单管理权限……',
  'Could not check waitlist management access. Try again.': '无法检查候补名单管理权限，请重试。',
  'Not notified yet': '尚未通知',

  'Booking waitlist': '预约候补',
  'Only team owners and admins can manage the waitlist.':
    '只有团队所有者和管理员可以管理候补名单。',
  'Waitlist management is unavailable for this account.': '此账户目前无法使用候补管理。',
  'Let invitees join a waitlist when no times are available':
    '没有可预约时间时，允许受邀人加入候补名单',
  'Eligible invitees are notified together. Nothing is reserved; the first successful booking wins. Turning this off removes the current entries without sending an email.':
    '系统会统一向符合条件的受邀人发送通知。不会预留任何时段，最先成功预约的人获得该时段。关闭此功能会移除现有候补条目，且不会发送邮件。',
  'Waitlists are available only for one-on-one event types with a single host (not round-robin or collective).':
    '候补名单仅适用于只有一位主持人的一对一活动类型（不含轮询和集体活动）。',
  'View waitlist entries': '查看候补名单',
  'Pending verification': '等待邮箱验证',
  'Waiting for a time': '等待空闲时段',
  Notified: '已通知',
  Removed: '已移除',
  'Waitlist entries': '候补名单',
  'Loading waitlist entries…': '正在加载候补名单……',
  'Could not load waitlist entries.': '无法加载候补名单。',
  '“Last notified” shows the latest time a mail server accepted a notification email, based on the records still retained. This does not confirm inbox delivery. Older notification records may have been cleared.':
    '“最近通知”显示现有记录中邮件服务器最近一次接受通知邮件的时间，并不代表邮件已送达收件箱。较早的通知记录可能已被清除。',
  'No waitlist entries.': '暂无候补条目。',
  'Contact details cleared': '联系信息已清除',
  'Requested period': '期望时段',
  'Last notified': '最近通知',
  'Notification time unavailable': '通知时间未知',
  'Remove entry': '移除条目',
  'Remove this waitlist entry? Their contact details will be cleared. No email will be sent.':
    '要移除此候补条目吗？联系信息将被清除，不会发送邮件。',
  'Could not remove the waitlist entry.': '无法移除此候补条目。',
  'Back to first page': '返回第一页',
  'Previous page': '上一页',
  'Next page': '下一页',
  Refresh: '刷新',

  'Enter button text so visitors can identify the button.':
    '请输入按钮文字，以便访客了解按钮的用途。',
  Embed: '嵌入',
  'More actions for {0}': '{0}的更多操作',
  'Embed {0}': '嵌入{0}',
  'Embedding configuration is unavailable. Ask the instance operator to confirm allowed website origins.':
    '暂时无法获取嵌入配置。请联系实例运维人员确认允许的网站来源。',
  'Embedding is disabled. The instance operator must set EMBED_ALLOWED_ORIGINS and restart the web process. For example:':
    '嵌入功能已停用。实例运维人员需要设置 EMBED_ALLOWED_ORIGINS 并重启网页服务。例如：',
  'Allowed website origins': '允许的网站来源',
  'Loading instance settings…': '正在加载实例设置……',
  'This event type is inactive. Enable it and save before generating embed code.':
    '此活动类型已停用。请先启用并保存，再生成嵌入代码。',
  'Complete the saved event setup before generating embed code.':
    '请先完善已保存活动的设置，再生成嵌入代码。',
  'This event type is unlisted. The embed still works; anyone with the code or direct link can book it.':
    '此活动类型未公开列出，但仍可嵌入。任何获得代码或直接链接的人都可以预约。',
  'Embed mode': '嵌入方式',
  Inline: '内嵌',
  'Popup button': '弹窗按钮',
  'Initial height (pixels)': '初始高度（像素）',
  'Use a whole number from 240 to 2000. The widget resizes automatically.':
    '请输入 240 到 2000 之间的整数。嵌入组件会自动调整高度。',
  'Button text': '按钮文字',
  'Embed code': '嵌入代码',
  'Copy embed code': '复制嵌入代码',
  'The instance public URL is unavailable for embedding. Ask the instance operator to check PUBLIC_URL.':
    '实例的公开网址暂时无法用于嵌入。请联系实例运维人员检查 PUBLIC_URL。',
  'This saved booking address cannot be embedded. Use a saved personal or team booking link.':
    '此已保存的预约地址无法嵌入。请使用已保存的个人或团队预约链接。',
  'Could not generate embed code. Check the embed settings and try again.':
    '无法生成嵌入代码。请检查嵌入设置，然后重试。',
  'Book a meeting': '预约会议',
  'After booking': '预约完成后',
  'Offer a Continue link after the booking confirmation. Invitees can review their calendar and manage link before leaving. Clear the URL to turn this off.':
    '在预约确认信息后提供继续访问链接。受邀人离开前可以查看日历信息和管理链接。清空网址即可关闭此功能。',
  'Continue to URL': '继续访问的网址',
  'Use HTTPS. The server checks the destination when you save.':
    '请使用 HTTPS 网址。保存时，服务器会检查目标地址。',
  'URL parameters': '网址参数',
  'Only selected values are added. Answers, guests, phone numbers and private booking links are never included.':
    '仅添加所选信息，不会包含问题回答、来宾、电话号码或私人预约链接。',
  'Event type slug': '活动类型链接标识',
  'Start time': '开始时间',
  'End time': '结束时间',
  'Host name': '主持人姓名',
  'Invitee name': '受邀人姓名',
  'Invitee email': '受邀人邮箱',
  'Warning: sharing invitee name or email makes them visible to the target site and its analytics, and may put them in browser history. Enable this only with a clear reason to share that data.':
    '警告：分享受邀人的姓名或邮箱后，目标网站及其分析工具将能看到这些信息，浏览器历史记录也可能保存这些信息。仅在确有必要分享时启用。',
  'Allow sharing invitee name and email': '允许分享受邀人姓名和邮箱',
  'Allow embedded bookings to open the parent page': '允许嵌入预约跳转所在页面',
  'Off by default: Continue opens a new tab from an embed. Enabling this allows an invitee’s click to replace the page containing the booking widget, when its sandbox permits it.':
    '默认关闭：从嵌入预约点击继续访问时，会打开新标签页。启用后，若沙箱允许，受邀人点击链接即可跳转嵌入预约组件所在的页面。',
  'Example continuation URL': '继续访问网址示例',
  'Enter a URL to preview the continuation.': '输入网址即可预览继续访问的地址。',
  'Sample values only. The server validates your settings on save.':
    '此处仅使用示例信息。保存时，服务器会验证设置。',
  'Check the after-booking settings and try again.': '请检查预约完成后的设置，然后重试。',
  'Use an absolute HTTPS URL of at most 2000 characters, without spaces or user information. Local hosts need permission from your instance operator.':
    '请输入不超过 2000 个字符的完整 HTTPS 网址，不得包含空格或用户认证信息。本地主机需要实例管理员授权。',
  'Choose only the listed URL parameters, without duplicates.':
    '请选择列表中的网址参数，不要重复选择。',
  'Allow sharing invitee name and email before selecting those parameters.':
    '选择受邀人姓名或邮箱参数前，请先允许分享这些信息。',
  'Choose whether embedded bookings may open the parent page.':
    '请选择是否允许嵌入预约跳转所在页面。',
  Revoked: '已撤销',
  'Event type': '活动类型',
  'Created by': '创建者',
  'Unknown member': '未知成员',
  'Load more': '加载更多',
  'This request already created a link, but its URL cannot be retrieved. Review the list and revoke it if needed, then start a new request.':
    '此请求已创建链接，但无法找回网址。请查看列表并按需撤销该链接，然后发起新请求。',
  'Start a new request': '发起新请求',
  'This link is no longer active.': '此链接已失效。',
  'One-time links': '一次性链接',
  'Create a private link that can be used for one booking. Each new URL is shown only once.':
    '创建仅可完成一次预约的私密链接。每个新网址只显示一次。',
  'These links belong to the team and remain with it when their creator leaves.':
    '这些链接归团队所有，创建者离开后仍保留在团队中。',
  'Close one-time links': '收起一次性链接',
  'Manage one-time links': '管理一次性链接',
  'Your space has reached its active one-time link limit. Revoke an unused link and try again.':
    '当前空间的有效一次性链接已达上限。请撤销一个未使用的链接后重试。',
  'Enable and save this event type before creating a one-time link.':
    '请先启用并保存此活动类型，再创建一次性链接。',
  'Check the expiry and invitee details, then try again.': '请检查到期时间和受邀人信息后重试。',
  'One-time links are unavailable with your current permissions.':
    '你当前的权限无法管理一次性链接。',
  'Could not update one-time links. Try again.': '无法更新一次性链接。请重试。',
  'In 1 hour': '1 小时后',
  'In 1 day': '1 天后',
  'In 7 days': '7 天后',
  Used: '已使用',
  'Create a one-time link': '创建一次性链接',
  'Link expiry': '链接到期时间',
  'A day is exactly 24 hours, including daylight-saving changes.':
    '一天为整整 24 小时，夏令时切换时也一样。',
  'Prefilled invitee name': '预填受邀人姓名',
  'Prefilled invitee email': '预填受邀人邮箱',
  'Invitees can edit these details. Prefill does not restrict who can book.':
    '受邀人可以修改这些信息。预填信息不会限制谁可以预约。',
  'Create one-time link': '创建一次性链接',
  'Existing one-time links': '已有一次性链接',
  'URLs cannot be retrieved from this list. Revoke an unused link if you no longer need it.':
    '无法从此列表找回网址。不再需要未使用的链接时，请将其撤销。',
  'Could not load one-time links. Your access may have changed.':
    '无法加载一次性链接。你的访问权限可能已改变。',
  'No one-time links yet. Create one above to share this event privately.':
    '还没有一次性链接。请在上方创建一个，以私密方式分享此活动。',
  'One-time link': '一次性链接',
  'Link ID': '链接编号',
  'Used at': '使用时间',
  'Booking reference': '预约编号',
  'Revoke link': '撤销链接',
  'Revoke one-time link {0}': '撤销一次性链接{0}',
  'Revoke this one-time link? It will stop accepting new bookings.':
    '撤销此一次性链接？撤销后将不再接受新预约。',
  'Copy your one-time link': '复制你的一次性链接',
  'Link created. Copy and save it privately now. After you close this dialog, the URL cannot be shown again.':
    '链接已创建。请立即复制并妥善保管。关闭此对话框后，将无法再次显示网址。',
  'One-time booking URL': '一次性预约网址',
  'Copy one-time link': '复制一次性链接',
  'Close and forget URL': '关闭并清除网址',
  'This link was already used. Its booking is unchanged.': '此链接已使用。对应预约保持不变。',
  'Link revoked.': '链接已撤销。',
  'Cancel in Hourmere before the meeting starts. Invitees cannot stop follow-ups after the start.':
    '请在会议开始前于 Hourmere 中取消预约。会议开始后，受邀人无法停止会后消息。',
  'Reminders and follow-ups': '提醒与会后消息',
  'Changes apply to new bookings only. Existing bookings and their reschedules keep their saved settings.':
    '更改仅适用于新预约。现有预约及其改期会保留原有设置。',
  'Reminders are sent only if the send time is more than 1 hour after the booking or reschedule; otherwise they are skipped and not sent late.':
    '仅当提醒的发送时间在预约创建或改期之后，且间隔超过 1 小时时才会发送；否则会跳过，不会补发。',
  'Follow-ups use the scheduled meeting end, regardless of attendance. Declining a calendar invitation does not cancel them.':
    '会后消息按预定的会议结束时间安排，无论对方是否参加。拒绝日历邀请不会取消这些消息。',
  'Email limits or delivery problems can prevent a message from being sent.':
    '邮件发送限额或投递问题可能导致消息无法发送。',
  'Pre-meeting reminders': '会前提醒',
  'Post-meeting follow-ups': '会后消息',
  'Up to {count} messages. Choose at least one recipient for each message.':
    '最多可添加{count}条消息。请为每条消息选择至少一类收件人。',
  'No reminders.': '尚无提醒。',
  'No follow-ups.': '尚无会后消息。',
  'Add reminder': '添加提醒',
  'Add follow-up': '添加会后消息',
  'Reminder {number}': '提醒{number}',
  'Follow-up {number}': '会后消息{number}',
  'Added reminder {number}.': '已添加提醒{number}。',
  'Added follow-up {number}.': '已添加会后消息{number}。',
  'Removed reminder {number}.': '已移除提醒{number}。',
  'Removed follow-up {number}.': '已移除会后消息{number}。',
  'Removed the saved host note from follow-up {number}.':
    '已移除会后消息{number}中保存的主持人留言。',
  'Timing preset': '预设时间',
  'Custom timing': '自定义时间',
  'Custom timing selected for reminder {number}. Enter minutes before the meeting in the next field.':
    '已为提醒{number}选择自定义时间。请在下一栏输入会议开始前的分钟数。',
  'Custom timing selected for follow-up {number}. Enter minutes after the meeting in the next field.':
    '已为会后消息{number}选择自定义时间。请在下一栏输入会议结束后的分钟数。',
  '24 hours before': '提前 24 小时',
  '2 hours before': '提前 2 小时',
  '30 minutes before': '提前 30 分钟',
  '1 hour after': '结束 1 小时后',
  '1 day after': '结束 1 天后',
  'Minutes before the meeting': '会议开始前的分钟数',
  'Minutes after the meeting': '会议结束后的分钟数',
  'Use 5–43,200 whole minutes, up to 30 days.': '请输入 5 至 43200 之间的整分钟数，最长为 30 天。',
  Recipients: '收件人',
  'Host note (optional)': '主持人留言（可选）',
  'Plain text only. Line breaks are allowed. Placeholders are sent as written.':
    '仅支持纯文本，可以换行。占位符会原样发送。',
  '{count} / {limit} characters': '{count}／{limit}个字符',
  'A saved host note is kept until you remove it. Notes will not be sent while this feature is disabled.':
    '已保存的主持人留言会保留，直到你将其移除。此功能停用期间不会发送留言。',
  'Host notes are unavailable because the instance operator has disabled them.':
    '实例运营者已停用主持人留言，此功能暂不可用。',
  'Remove saved host note': '移除已保存的主持人留言',
  'Remove reminder {number}': '移除提醒{number}',
  'Remove follow-up {number}': '移除会后消息{number}',
  'Remove reminder': '移除提醒',
  'Remove follow-up': '移除会后消息',
  'Choose at least one recipient.': '请选择至少一类收件人。',
  'Use each reminder or follow-up time only once per list.':
    '每个列表中的提醒或会后消息时间不可重复。',
  'Add at most {count} messages to this list.': '此列表最多可添加{count}条消息。',
  'Use plain text with line breaks only; remove tabs and other control characters.':
    '请使用纯文本，仅允许换行。请移除制表符及其他控制字符。',
  'Use valid Unicode text.': '请使用有效的 Unicode 文本。',
  'Host notes are disabled on this instance. Remove saved notes before changing reminders or follow-ups.':
    '此实例已停用主持人留言。更改提醒或会后消息前，请先移除已保存的留言。',
  'Reload the event type and try again.': '请重新加载活动类型后再试。',
  'Allowed durations': '可选时长',
  'Offer 1–12 different lengths, from 1 to 1,440 minutes. Invitees choose a length before a time.':
    '提供 1–12 种不同时长，每种为 1–1440 分钟。受邀人先选择时长，再选择时间。',
  'Offered lengths': '已提供的时长',
  'Keep at least one length. Removing the default selects the first remaining length.':
    '请保留至少一种时长。移除默认时长后，将使用剩余的第一种时长作为默认值。',
  'Quick durations': '常用时长',
  'Add {0}': '添加{0}',
  'Duration to add (minutes)': '要添加的时长（分钟）',
  'Add duration': '添加时长',
  'Default duration': '默认时长',
  'Selected when an invitee opens the booking page. They can choose another offered length.':
    '受邀人打开预约页面时，将预选此时长。他们可以选择你提供的其他时长。',
  'This duration is already in the list.': '此时长已在列表中。',
  'Offer from 1 to 12 durations.': '请提供 1–12 种时长。',
  'Offer each duration only once.': '每种时长只能提供一次。',
  'Include the default duration in the allowed durations.': '请在可选时长中包含默认时长。',
  'Added {0}.': '已添加{0}。',
  'Removed {0}. Default duration: {1}.': '已移除{0}。默认时长：{1}。',
  Scope: '权限范围',
  'Bookings (read/write)': '预约读写',
  'Read only': '只读',
  'Bookings — recommended for AI agents': '预约读写（推荐用于 AI 智能体）',
  'Read — analytics and reporting': '只读（用于分析和报表）',
  'Full account access': '账户完整访问权限',
  'Unknown scope': '权限范围未知',
  'View event types, available times and bookings you can access. Create, reschedule or cancel bookings, and retry their conference or your calendar copy. Cannot change settings or read analytics, raw schedules or integration accounts.':
    '查看你有权访问的活动类型、可预约时段和预约。创建、改期或取消预约，以及重试预约的会议或你自己的日历副本。无法修改设置，也无法读取统计、原始时间表或集成账户。',
  'Read data you can access, including bookings and attendee details, schedules, analytics and integration metadata. Cannot create, change or cancel bookings, or change settings.':
    '读取你有权访问的数据，包括预约和参会人详情、时间表、统计和集成元数据。无法创建、修改或取消预约，也无法修改设置。',
  'Use all operations available to API keys with your permissions. This includes changing settings and cancelling bookings. Only choose this for a client you trust with full account access.':
    '在你的权限内执行 API 密钥支持的所有操作，包括修改设置和取消预约。请仅为你信任、可以授予账户完整访问权限的客户端选择此范围。',
  'Your agent can view event types, available times and bookings you can access, including attendee details and answers. It can create, reschedule or cancel bookings and retry their conference or your calendar copy. It cannot change settings or read analytics, raw schedules or integration accounts.':
    '你的智能体可以查看你有权访问的活动类型、可预约时段和预约，包括参会人详情和回答。它可以创建、改期或取消预约，以及重试预约的会议或你自己的日历副本。它无法修改设置，也无法读取统计、原始时间表或集成账户。',
  'Your agent can read data you can access, including bookings, attendee details, schedules and analytics through the API. MCP offers the permitted read tools. It cannot create, change or cancel bookings, or change settings.':
    '你的智能体可以通过 API 读取你有权访问的数据，包括预约、参会人详情、时间表和统计。MCP 提供此范围允许的读取工具。它无法创建、修改或取消预约，也无法修改设置。',
  'Your agent can use every MCP tool and all API operations available to API keys with your permissions, including changing settings and cancelling bookings. Browser-only actions, including managing API keys, still require you to sign in.':
    '你的智能体可以在你的权限内使用所有 MCP 工具和 API 密钥支持的所有 API 操作，包括修改设置和取消预约。管理 API 密钥等仅限浏览器的操作仍需你登录后进行。',
  'API keys let AI agents and scripts use Hourmere for you. Each key acts in one organization, limited by its scope and your permissions. Treat it like a password.':
    'API 密钥让 AI 智能体和脚本代你使用 Hourmere。每个密钥作用于一个组织，受其权限范围和你的权限限制。请像保护密码一样妥善保管密钥。',
  'Scope cannot be changed after creation. To change it, create a new key and revoke the old one.':
    '密钥创建后无法修改权限范围。如需更改，请创建新密钥并撤销旧密钥。',
  'Review the scope and expiration, create and test the new key, then revoke the old one.':
    '请检查权限范围和到期时间，创建并测试新密钥，然后撤销旧密钥。',
  'Create replacement': '创建替代密钥',
  'Create a replacement for {0}': '为{0}创建替代密钥',
  'Cancel replacement': '取消替换',
  ' (replacement)': '（替换）',
  'Replacement expires: {0}': '替代密钥到期时间：{0}',
  'After testing the new key, revoke the old key “{0}” ({1}).':
    '测试新密钥后，请撤销旧密钥“{0}”（{1}）。',
  'Switch to this key’s organization to create a replacement.':
    '请切换到此密钥的所属组织，再创建替代密钥。',
  'Save your new key before creating another replacement.': '请先保存新密钥，再创建其他替代密钥。',
  'Wait until key creation finishes before creating a replacement.':
    '请等待密钥创建完成，再创建替代密钥。',
  'This key’s scope is unavailable. Revoke it and create a new key.':
    '无法确认此密钥的权限范围。请撤销此密钥并创建新密钥。',
  'Scope: {scope}': '权限范围：{scope}',
  'This API key does not allow this operation.': '此 API 密钥不允许执行这项操作。',
  'API key scope cannot be changed; create a replacement key.':
    'API 密钥的权限范围无法修改；请创建新密钥来替换。',
  'Use a browser session without an Authorization header.':
    '请使用浏览器登录会话，并移除 Authorization 请求头。',
  'Check the API key organization and scope.': '请检查 API 密钥的所属组织和权限范围。',
  'View hosted team events': '查看主持的团队活动',
  'Showing team events with this member as a host or pool candidate.':
    '当前显示该成员主持或参与候选池的团队活动。',
  'Show all event types': '显示全部活动类型',
  'This member does not host any team events.': '该成员未主持任何团队活动。',
  'Only team owners and admins can change host assignments.':
    '只有团队所有者和管理员可以修改主持人配置。',
  'You are a selected host.': '你是已选主持人。',
  'Review member setup': '查看成员设置',
  'Ask this member to review their personal working hours and calendars. Only they can change their private schedule.':
    '请该成员检查个人工作时间和日历。只有成员本人可以修改其私人时间表。',
  'No longer valid': '已失效',
  'The inviter is no longer a team member. Cancel this invitation and send a fresh invitation in your own name.':
    '邀请人已不再是团队成员。请取消此邀请，再以你自己的名义发送一封全新邀请。',
  'Your booking page is ready': '你的预约页面已就绪',
  'No active event type': '暂无启用的活动类型',
  'You have no active event type. Activate one when you are ready to accept bookings.':
    '你目前没有启用的活动类型。准备好接受预约时，再启用即可。',
  'Review event type': '查看活动类型',
  'Could not refresh setup status.': '无法刷新设置状态。',
  'Set up your booking page': '设置你的预约页面',
  'Complete these steps at your own pace. You can keep using the app as you go.':
    '按自己的节奏完成这些步骤。设置过程中仍可继续使用应用。',
  'Your display name and booking address are set.': '你的显示名称和预约地址已设置。',
  'Choose your display name, handle and time zone in Settings.':
    '在设置中填写显示名称、用户名和时区。',
  'Without a display name, your booking page, emails and calendar invitations show your handle instead.':
    '如果未填写显示名称，预约页面、邮件和日历邀请将显示你的用户名。',
  'Complete your profile': '完善个人资料',
  'Default availability': '默认可预约时间',
  'Your default schedule has weekly hours ready for bookings.':
    '你的默认日程已设置每周可预约时间。',
  'Start with Monday–Friday, 09:00–17:00 in your profile time zone: {0}.':
    '先用周一至周五 09:00–17:00（个人资料时区：{0}）作为默认可预约时间。',
  'not set': '未设置',
  'Complete your profile before confirming these hours.': '请先完善个人资料，再确认这些时间。',
  'Use Monday–Friday, 09:00–17:00': '使用周一至周五 09:00–17:00',
  'You can change these hours later in Availability.': '之后可在可预约时间页面调整这些时间。',
  'Choose a default schedule with valid weekly hours. Other schedules do not complete this step.':
    '请选择每周时间有效的默认日程。其他日程不计入此步骤。',
  'Review default availability': '检查默认可预约时间',
  'Could not confirm your default availability.': '无法确认你的默认可预约时间。',
  'Refresh setup status': '刷新设置状态',
  'First event type': '首个活动类型',
  'An event type sets the meeting length and gives invitees a booking link.':
    '活动类型决定会议时长，并为受邀者提供预约链接。',
  'View and share': '查看与分享',
  'Open your booking page to check the available times, then copy its link to share.':
    '打开预约页面检查可预约时间，然后复制链接进行分享。',
  'View booking page': '查看预约页面',
  'Copy booking link': '复制预约链接',
  'Activate your first event type': '启用首个活动类型',
  'Your link will appear after you set up a profile, valid default availability and an active event type.':
    '设置个人资料、有效的默认可预约时间和启用的活动类型后，这里会显示链接。',
  'Calendar connection (optional)': '连接日历（可选）',
  'Skipped for now. You can connect a calendar later.': '已暂时跳过。之后随时可以连接日历。',
  'You can take bookings without connecting an external calendar.':
    '无需连接外部日历，也可以接受预约。',
  'Connect a calendar': '连接日历',
  'Skip for now': '暂时跳过',
  Complete: '已完成',
  'Next step': '下一步',
  'To do': '待完成',
  'Complete your profile and display name in Settings first.':
    '请先在设置中完善个人资料和显示名称。',
  'Review your existing schedules and choose a valid default in Availability.':
    '请在可预约时间页面检查已有日程，并选择有效的默认日程。',
  'Use this key with MCP': '使用此密钥连接 MCP',
  'Loading MCP configuration…': '正在加载 MCP 配置……',
  'Could not load MCP configuration.': '无法加载 MCP 配置。',
  'MCP client JSON': 'MCP 客户端 JSON 配置',
  'Copy MCP JSON': '复制 MCP JSON 配置',
  'Claude Code command': 'Claude Code 命令',
  'Copy Claude command': '复制 Claude 命令',
  'Use the JSON in a client that supports remote MCP servers with HTTP headers, or run the Claude Code command. Configuration keys may vary by client.':
    '将 JSON 配置粘贴到支持通过 HTTP 请求头连接远程 MCP 服务器的客户端，或运行 Claude Code 命令。不同客户端的配置字段可能有所不同。',
  'Member readiness': '成员就绪状态',
  'Default schedule set': '已设置默认时间表',
  'No default schedule': '未设置默认时间表',
  'Default schedule not checked': '尚未检查默认时间表',
  'Default schedule needs attention': '默认时间表需要处理',
  'Default schedule check failed': '默认时间表检查失败',
  'Selected calendar checks passed': '所选日历检查通过',
  'No external conflict calendar required for basic bookings': '基本预约无需外部冲突检查日历',
  'Selected calendars need attention': '所选日历需要处理',
  'Selected calendars not checked': '尚未检查所选日历',
  'Selected calendar check failed': '所选日历检查失败',
  'Conference account connected': '已连接会议账户',
  'No conference account connected; basic bookings do not require one':
    '未连接会议账户；基本预约无需会议账户',
  'Conference accounts need attention': '会议账户需要处理',
  'Conference accounts not checked': '尚未检查会议账户',
  'Conference account check failed': '会议账户检查失败',
  'Only team owners and admins can view other members’ readiness.':
    '仅团队所有者和管理员可查看其他成员的就绪状态。',
  'Your default schedule is reused in every team you belong to.':
    '你加入的所有团队共用你的个人默认时间表。',
  'Configure default schedule': '配置默认时间表',
  'Configure calendars': '配置日历',
  'A missing default schedule is a configuration gap, not a report of no free time.':
    '未设置默认时间表表示配置缺失，不表示当前没有空闲时间。',
  'An external calendar is optional for basic bookings.': '基本预约无需连接外部日历。',
  'Checking member configuration…': '正在检查成员配置…',
  'Could not check member configuration.': '无法检查成员配置。',
  'Filter invitations': '筛选邀请',
  Joined: '已加入',
  Rejected: '已拒绝',
  'Invitation status unknown': '邀请状态未知',
  'You do not have permission to manage invitations.': '你没有管理邀请的权限。',
  'This invitation is no longer available for resending.': '此邀请已无法重新发送。',
  'Wait for the resend cooldown before trying again.': '请等待重发冷却时间结束后再试。',
  'This invitation cannot be resent. Check its status again.':
    '此邀请无法重新发送。请再次检查其状态。',
  'Check invitation status to see whether resending is now allowed.':
    '请检查邀请状态，确认现在是否允许重发。',
  'The recipient has joined. Their membership was not changed.':
    '受邀者已加入团队。其成员身份未被更改。',
  'Invitation cancelled. Its link can no longer be used.': '邀请已取消，其链接已无法使用。',
  'Invitation status refreshed.': '邀请状态已刷新。',
  'An email already being sent may still arrive. This invitation can no longer be used.':
    '已开始发送的邮件仍可能到达，但此邀请已无法使用。',
  'Could not confirm the invitation status. Check its status before trying another action.':
    '无法确认邀请状态。请先检查状态，再尝试其他操作。',
  'A new invitation may have been saved. Review Pending invitations before trying another action.':
    '新邀请可能已保存。请先查看待接受的邀请，再尝试其他操作。',
  'Send a new invitation': '发送新邀请',
  'Cancel invitation': '取消邀请',
  'Cancel this invitation?': '要取消此邀请吗？',
  'Cancelling only voids this invitation. It never removes a member who has already joined.':
    '取消操作仅使此邀请失效，不会移除已加入团队的成员。',
  'Confirm cancellation': '确认取消邀请',
  'Keep invitation': '保留邀请',

  'Only owners can manage admins. Ownership transfer is not available yet.':
    '只有所有者可以管理管理员。暂不支持转移所有权。',
  'Owner roles cannot be changed here. The team must retain at least one owner.':
    '此处不能更改所有者角色。团队必须保留至少一位所有者。',
  'Make admin': '设为管理员',
  'Make member': '设为成员',
  'Make admin: {0}': '设为管理员：{0}',
  'Make member: {0}': '设为成员：{0}',
  'Change team role': '更改团队角色',
  'Change {name} from {oldRole} to {newRole}?': '将{name}从{oldRole}改为{newRole}？',
  'They will gain admin permissions.': '此人将获得管理员权限。',
  'They will lose admin permissions and keep member access.':
    '此人将失去管理员权限，保留成员访问权限。',
  'Admins can invite and remove ordinary members, manage team events, and view team bookings and cancel them before they start.':
    '管理员可以邀请和移除普通成员、管理团队活动、查看团队预约，以及在会议开始前取消预约。',
  'Members can view team members and manage their own availability, calendars and hosted bookings.':
    '成员可以查看团队成员，管理自己的可预约时间、日历及本人主持的预约。',
  'Confirm role change': '确认更改角色',
  'Changing role…': '正在更改角色…',
  '{name} is now {role}.': '已将{name}设为{role}。',
  'This role change was denied. Your permission or this member’s team membership may have changed. Reload to check.':
    '此次角色更改被拒绝。你的权限或此人的团队成员关系可能已变更，请重新加载并核实。',
  'This person is no longer a member of this team. Reload the member list.':
    '此人已不再是此团队的成员。请重新加载成员列表。',
  'This role change conflicts with the current team state. Reload before trying again.':
    '此次角色更改与当前团队状态冲突。请重新加载后再试。',
  'Could not confirm the role change. Reload to check this person’s current role before trying again.':
    '无法确认角色更改结果。请重新加载并核实此人的当前角色后再试。',
  'The invitation request could not be queued. Try again later.':
    '无法将邀请请求加入队列。请稍后再试。',
  'Invite member': '邀请成员',
  'Invitations always use the member role.': '邀请的角色固定为普通成员。',
  'Invitation queued for delivery.': '邀请已加入投递队列。',
  'Queueing invitation…': '正在将邀请加入队列…',
  'Waiting to send': '等待发送',
  'An invitation already exists. Review its mail submission status below.':
    '邀请已存在。请查看下方的邮件提交状态。',
  'An invitation is already pending for this address. Review the pending invitations.':
    '此邮箱已有待接受的邀请。请查看待接受的邀请列表。',
  'This address already belongs to a team member.': '此邮箱已属于团队成员。',
  'This team has reached its pending invitation limit. Resolve pending invitations before inviting more people.':
    '本团队已达到待接受邀请数量上限。请先处理现有邀请，再邀请更多成员。',
  'Enter a valid email address.': '请输入有效的邮箱地址。',
  'The invitation was saved, but delivery could not be queued. Retry with the same email address.':
    '邀请已保存，但无法加入投递队列。请使用同一邮箱地址重试。',
  'A newer invitation exists for this address. Review the pending invitations.':
    '此邮箱已有更新的邀请。请查看待接受的邀请。',
  'The invitation changed. Reload before trying again.': '邀请已更改。请重新加载后再试。',
  'This invitation is no longer pending. Reload before trying again.':
    '此邀请已不再处于待接受状态。请重新加载后再试。',
  'You do not have permission to invite members.': '你没有邀请成员的权限。',
  'Invitation requests are temporarily limited. Try again later.':
    '邀请请求暂时受到限制。请稍后再试。',
  'Try again in {0} seconds.': '请在{0}秒后重试。',
  'On a restricted instance, an invitation permits sign-up only when the inviter is the instance’s earliest user or has a currently allowed email domain. The recipient must verify this exact address and accept the invitation separately to join.':
    '在限制注册的实例上，仅当邀请者为实例首位用户，或其当前邮箱域名在允许名单中时，邀请才允许注册。受邀者须验证该确切邮箱地址，并另行接受邀请才能加入团队。',
  'This host’s time zone is unavailable.': '无法获取此主持人的时区。',
  'Host time zone: {zone}': '主持人时区：{zone}',
  'Book again with another host': '重新预约其他主持人',
  'A host has left the team, so this booking cannot be rescheduled. Hourmere does not automatically assign another host.':
    '一位主持人已离开团队，因此此预约无法改期。Hourmere 不会自动指派其他主持人。',
  'An admin cancels this booking here before it starts.': '管理员在预约开始前，在此页面取消预约。',
  'This booking is already cancelled. Continue with the next step.': '此预约已取消，请继续下一步。',
  'This booking has already started. Wait until it ends or coordinate with the hosts offline.':
    '此预约已开始，请等待结束或与主持人线下协调。',
  'Then ask the guest to book again from the event’s public booking page.':
    '然后请访客从活动的公开预约页面重新预约。',
  'Open public booking page': '打开公开预约页面',
  'The event is no longer bookable.': '此活动已无法预约。',
  'Ask an admin to repair and reactivate the event, or create a new event, before the guest books again.':
    '请管理员修复并重新启用此活动，或创建新活动，再请访客重新预约。',
  'Cancellation notifications are queued. Email delivery is not confirmed.':
    '取消通知已加入发送队列，邮件是否送达尚未确认。',
  'Your time zone: {zone}': '你的时区：{zone}',
  'Cancellation notifications': '取消通知',
  'Cancellation emails go to the invitee and guests below, and saved hosts who are still verified members of this team. Departed hosts are not notified.':
    '取消邮件将发给下列预约访客和来宾，以及仍是本团队成员且邮箱已验证的原主持人。已离队的主持人不会收到通知。',
  'Email delivery is not guaranteed. Contact the invitee directly if needed.':
    '无法保证邮件送达，请按需直接联系预约访客。',
  'Hourmere does not automatically assign another host. A replacement requires a new booking.':
    'Hourmere 不会自动指派其他主持人。如需替代安排，必须重新预约。',
  'Join team': '加入团队',
  'Go to team': '前往团队',
  'Invited email': '受邀邮箱',
  'You are already a member of {team}.': '你已经是{team}的成员。',
  'If you cannot sign in with the invited email, ask the team owner to check the invitation or contact this instance’s administrator about registration access.':
    '如果无法使用受邀邮箱登录，请联系团队所有者检查邀请，或联系此实例的管理员咨询注册权限。',
  Pending: '待接受',
  'Team members': '团队成员',
  'Pending invitations are not members or hosts.': '待接受的邀请不计入成员或主持人。',
  'Manage team events': '管理团队活动',
  'Could not load team members.': '无法加载团队成员。',
  'You do not have permission to view team members.': '你没有查看团队成员的权限。',
  '{0} joined members': '{0}位已加入的成员',
  'No team members found.': '未找到团队成员。',
  'Previous members page': '上一页成员',
  'Next members page': '下一页成员',
  'Pending invitations': '待接受的邀请',
  'Mail server acceptance does not confirm receipt in the inbox.':
    '邮件服务器接受邮件并不代表邮件已到达收件箱。',
  'Loading pending invitations…': '正在加载待接受的邀请…',
  'Could not load pending invitations.': '无法加载待接受的邀请。',
  'You do not have permission to view pending invitations.': '你没有查看待接受邀请的权限。',
  'No pending invitations on this page.': '本页没有待接受的邀请。',
  'Invitation to {email}': '发给{email}的邀请',
  'Invited {time}': '邀请时间：{time}',
  'Resend invitation': '重新发送邀请',
  'Invitation delivery is in progress. Try again shortly.': '邀请正在投递中。请稍后再试。',
  'This invitation has reached its resend limit.': '此邀请已达到重新发送次数上限。',
  'Mail submission': '邮件提交状态',
  Submitted: '已提交',
  'Submitting to the mail server': '正在提交至邮件服务器',
  'Accepted by the mail server': '邮件服务器已接受',
  'Submission failed': '提交失败',
  'Submission skipped': '已跳过提交',
  'Submission status unknown': '提交状态未知',
  'Previous invitations page': '上一页邀请',
  'Next invitations page': '下一页邀请',
  'Loading team bookings…': '正在加载团队预约…',
  'Team bookings': '团队预约',
  'Owners and admins can view this team’s bookings and cancel bookings before they start.':
    '所有者和管理员可以查看本团队的预约，并在预约开始前取消预约。',
  Team: '团队',
  'Access revoked': '访问权限已撤销',
  'Team bookings access is no longer available.': '团队预约访问权限已失效。',
  'Team bookings are not available in this space.': '当前空间无法查看团队预约。',
  'Your team access may have changed. Return to your bookings or choose another space.':
    '你的团队访问权限可能已更改。请返回本人的预约，或选择其他空间。',
  'Choose a team where you are an owner or admin to view its bookings.':
    '请选择你担任所有者或管理员的团队，查看该团队的预约。',
  'Go to your bookings': '前往本人的预约',
  'All bookings': '全部预约',
  'Filter bookings': '筛选预约',
  'Filter times use this browser’s time zone: {zone}.': '筛选时间使用当前浏览器的时区：{zone}。',
  'All statuses': '全部状态',
  Order: '排序',
  'Oldest first': '最早优先',
  'Newest first': '最新优先',
  'Upcoming includes meetings in progress. Custom end-time filters replace the tab’s time range.':
    '即将进行包含正在进行的会议。自定义结束时间筛选会替换标签页的时间范围。',
  'Apply filters': '应用筛选',
  'Clear filters': '清除筛选',
  'Could not load team bookings.': '无法加载团队预约。',
  'Oldest first. ': '最早优先。',
  'Times are in {zone}, this browser’s time zone.': '时间以当前浏览器的时区{zone}显示。',
  'No team bookings match these filters.': '没有符合筛选条件的团队预约。',
  'Try another time range or clear the filters. New team bookings will appear here.':
    '请尝试其他时间范围或清除筛选。新的团队预约会显示在这里。',
  'Deleted event type': '已删除的活动类型',
  ' + {0} guests': ' + {0}位来宾',
  'Co-hosts': '共同主持人',
  'Team booking details': '团队预约详情',
  'Close details': '关闭详情',
  'Booking ID': '预约ID',
  'Event type ID': '活动类型ID',
  'Host ID: {0}': '主持人ID：{0}',
  Guest: '来宾',
  'This booking has already started, so it can no longer be cancelled. Wait until it ends or coordinate with the hosts offline.':
    '此预约已经开始，无法再取消。请等待预约结束，或与主持人线下协调。',
  'Starts at or after': '开始时间不早于',
  'Starts before': '开始时间早于',
  'Ends after': '结束时间晚于',
  'Ends at or before': '结束时间不晚于',
  'Selected calendars cannot provide conflict checks.': '所选日历无法提供冲突检查。',
  'Configuration checks': '配置检查',
  'Configuration checks passed': '配置检查通过',
  'Configuration needs attention': '配置需要处理',
  'Calendar sync needs attention': '日历同步需要处理',
  'Some hosts need attention': '部分主持人需要处理',
  'Configuration not checked': '配置尚未确认',
  'Configuration check failed': '配置检查失败',
  'Checking configuration…': '正在检查配置…',
  'Retry checks': '重试检查',
  'Round robin activated': '轮询已激活',
  'Configuration checks do not guarantee available times. Check the booking page for current availability.':
    '配置检查不保证有可约时段。当前可约时间以预约页为准。',
  'Working hours are missing.': '缺少工作时间设置。',
  'Host settings need attention.': '主持人设置需要处理。',
  'Selected calendars are waiting for a successful sync.': '所选日历正在等待同步成功。',
  'Automatic meeting settings need attention.': '自动会议设置需要处理。',
  'Ask the hosts to review their personal working hours and calendars.':
    '请主持人检查本人的工作时间和日历设置。',
  'Review hosts': '检查主持人',
  'Review event settings': '检查活动设置',
  'Set working hours': '设置工作时间',
  'Review schedule': '检查时间表',
  'Review calendar sync': '检查日历同步',
  'Sign in to verify your identity': '登录以验证身份',
  'Review profile': '检查个人资料',
  'Review conference accounts': '检查会议账户',
  'Calendar permissions need review': '日历权限需要复核',
  'Selected for new bookings — review permissions': '已选为新预约写入目标，请复核权限',
  'Permissions required': '需要授权',
  'Calendar permissions need attention. Busy-time synchronization is reported separately below.':
    '日历权限需要处理。忙碌时段的同步结果会在下方单独显示。',
  'Choose {0} on the {1} authorization page. Connecting a different account will not restore this one.':
    '请在{1}授权页面选择{0}。连接其他账户不会恢复此账户。',
  'Choose the original account on the {0} authorization page.': '请在{0}授权页面选择原账户。',
  'Reconnect {0} Calendar': '重新连接{0}日历',
  'Restore calendar permissions': '恢复日历权限',
  'Retry synchronization': '重试同步',
  'Choose another booking calendar': '选择其他预约写入日历',
  'Review availability time zone': '查看可用时间的时区',
  '{0} Calendar connected. Your calendar list is ready. Review the account status below to confirm which account connected.':
    '{0}日历已连接。日历列表已就绪。请查看下方账户状态，确认实际连接的账户。',
  'Review synchronization permissions': '查看同步权限说明',
  'Unavailable for new bookings': '暂不能写入新预约',
  'Selected for new bookings — unavailable': '已选为新预约写入目标，暂不可用',
  'Calendar connection options': '日历连接选项',
  'Reconnect required': '需要重新连接',
  'Busy-time sync': '忙碌时段同步',
  'Conflict checks': '冲突检查',
  'New bookings': '新预约',
  'Not available': '暂不可用',
  '{0} selected': '已选择{0}个日历',
  'Not available — calendar list only.': '暂不支持，仅可查看日历列表。',
  'Not enabled — calendar list only.': '尚未启用，仅可查看日历列表。',
  'Paused until you reconnect this account.': '已暂停，请重新连接此账号。',
  'Unavailable on this instance.': '此实例暂不可用。',
  'Synchronization needs attention. Review the failed calendars below.':
    '同步需要处理，请查看下方同步失败的日历。',
  'Synchronization is not ready for selected calendars yet.': '所选日历的同步数据尚未就绪。',
  'No calendars selected for conflict checks.': '尚未选择用于冲突检查的日历。',
  'Latest synchronization of selected conflict calendars succeeded.':
    '所选冲突检查日历的最近一次同步已成功。',
  'Not written to this account': '不写入此账号',
  'Selected for conflict checks': '已选为冲突检查日历',
  'Not used for conflict checks': '不用于冲突检查',
  'Selected for new bookings': '已选为新预约写入目标',
  'Not a booking destination': '不写入新预约',
  'The calendar provider could not be reached. Try refreshing the calendar list again.':
    '无法连接日历服务，请重试刷新日历列表。',
  'Connecting a calendar is optional. Basic booking works without one. Set up an event type to start taking bookings.':
    '日历连接是可选的。不连接日历也能使用基础预约。设置活动类型，即可开始接受预约。',
  'Set up event types': '设置活动类型',
  'Busy times synchronized for this calendar.': '此日历的忙碌时段已同步。',
  'Disconnect deletes stored credentials and local calendar data, but leaves existing event copies in Google Calendar and does not revoke your Google grant. You can revoke access in your Google Account:':
    '“断开连接”可删除已存储的凭证和本地日历数据，但会保留 Google 日历中的现有事件副本，也不会撤销 Google 授权。你可以在 Google 账号中撤销授权：',
  'Team name': '团队名称',
  'Team public address': '团队公开地址',
  'This address is kept for a safe retry. Check the existing team before starting another creation.':
    '为安全重试，已保留此地址。再次创建其他团队前，请先核对已有团队。',
  'Enter a team name on one line, up to 200 characters.': '请输入单行团队名称，最多 200 个字符。',
  'Choose a name and public address for your team.': '为团队选择名称和公开地址。',
  'Use a name your teammates will recognize, up to 200 characters.':
    '使用团队成员熟悉的名称，最多 200 个字符。',
  'Team addresses preserve letter case and are separate from personal handles.':
    '团队地址区分字母大小写，与个人用户名互相独立。',
  'Team booking URL preview': '团队预约网址预览',
  'Each team event gets its own address at the end of this URL. Creating a team does not publish a booking page.':
    '每个团队活动都会在此网址末尾使用独立的活动地址。创建团队不会发布预约页面。',
  'A team with this address is in your teams. Open it to continue.':
    '你的团队列表中已有使用此地址的团队。打开该团队以继续。',
  'No team was found at this address. You can try creating it again.':
    '未找到使用此地址的团队。你可以再次尝试创建。',
  'Creation could not be confirmed. Checking your teams before retrying…':
    '无法确认创建结果。正在检查团队列表，以便安全重试…',
  'Could not check your teams. Check team status before trying again.':
    '无法检查团队列表。请先检查团队状态，再尝试创建。',
  'Open team': '打开团队',
  'Check team status': '检查团队状态',
  'Creating team…': '正在创建团队…',
  'Create team': '创建团队',
  'Your role': '你的角色',
  'Last confirmed role': '上次确认的角色',
  Owner: '所有者',
  Admin: '管理员',
  Member: '成员',
  'Loading your team role…': '正在加载你的团队角色…',
  'Could not load your team role.': '无法加载你的团队角色。',
  'API key usage command': 'API 密钥使用命令',
  'New API key test command': '新 API 密钥测试命令',
  'No schedules yet.': '尚无日程。',
  'Ask your administrator to enable calendar connections.': '请联系管理员启用日历连接。',
  'Ask your administrator to enable Zoom connections.': '请联系管理员启用 Zoom 连接。',
  'Set the booking details, questions and availability for this event type.':
    '设置此活动类型的预约信息、问题和可预约时段。',
  'Set your weekly hours in the time zone people can book you in.':
    '设置每周可预约时段及其所在时区。',

  'Manage your profile and booking defaults.': '管理个人资料和预约默认设置。',
  'Review and manage the meetings you host.': '查看和管理你主持的会议。',
  'Review meeting details and manage this booking.': '查看会议详情并管理此预约。',
  'Notification language': '通知语言',
  'Choose a supported notification language.': '请选择支持的通知语言。',
  'Language of your own notification emails and calendar invitations. Booking pages and invitee emails use the visitor’s language. The admin interface also uses this language until you choose an interface language in the top bar. After that, the two languages are independent.':
    '你收到的通知邮件和日历邀请所用的语言。预约页面和受邀者邮件使用访客的语言。在顶栏选择界面语言之前，管理界面也使用此语言；选择后，两种语言互不影响。',
  'Connect a calendar account to get started.': '连接日历账号以开始使用。',
  'This Google calendar uses {calendarZone}; your availability uses {scheduleZone}. Bookings land at the same moment; Google Calendar usually shows them in {calendarZone} time.':
    '此 Google 日历使用{calendarZone}时区；你的可预约时段使用{scheduleZone}时区。预约对应同一时刻；Google 日历通常以{calendarZone}时间显示。',
  'Connect an AI app from its MCP settings, or use an API key.':
    '在 AI 应用的 MCP 设置中连接，或使用 API 密钥。',
  'Manage API keys': '管理 API 密钥',
  'Create your first key': '创建第一个密钥',
  'Give the key a name above, then choose Create key.': '在上方为密钥命名，然后选择“创建密钥”。',
  'Connect a Zoom account to get started.': '连接 Zoom 账号以开始使用。',
  'Review calendar connection options': '查看日历连接选项',
  'Removal pending save': '移除待保存',
  'Undo removal: {0}': '撤销移除：{0}',
  'Undo removal': '撤销移除',

  '.': '。',
  '{0}–{1}.': '{0}–{1}。',
  '= {0}.': '= {0}。',
  'Anyone who knows or guesses the direct link can still book it. Unlisted is not access control.':
    '任何知道或猜到直接链接的人仍可预约。未公开列出不代表访问控制。',
  'You can add a random suffix to make the link harder to guess. This is optional.':
    '你可以添加随机后缀，让链接更难被猜到。此操作为可选项。',
  'Use suggested link': '使用建议的链接',
  'Connect your own Zoom account separately from sign-in and calendars. Identity access and automatic meeting permissions are separate choices.':
    '单独连接你自己的 Zoom 账号，与登录和日历互相独立。身份访问与自动创建会议权限需要分别选择。',
  'Connect Zoom requests only basic account identity. Authorize Zoom meetings also requests create, read, update and delete meeting access. You choose your own connection when configuring automatic meetings.':
    '“连接 Zoom”仅请求基本账号身份。“授权 Zoom 会议”还会请求创建、读取、更新和删除会议的权限。配置自动会议时，由你选择自己的连接。',
  'Connect Zoom requests only basic account identity.': '“连接 Zoom”仅请求基本账号身份。',
  'Authorize Zoom meetings': '授权 Zoom 会议',
  'Meeting permissions': '会议权限',
  'Identity only': '仅身份访问',
  'New automatic Zoom authorization is disabled on this instance. Existing connections reconnect with their saved permissions.':
    '此实例已关闭新的自动 Zoom 授权。现有连接会按已保存的权限重新连接。',
  'Identity-only authorization cannot replace meeting permissions. Reconnect this Zoom account with its existing meeting permissions.':
    '仅身份授权不能替换会议权限。请使用此 Zoom 账号原有的会议权限重新连接。',
  'Zoom did not return exactly the requested permissions. Check the app configuration and reconnect.':
    'Zoom 返回的权限与所请求的权限不完全一致。请检查应用配置后重新连接。',
  'Automatic Zoom meetings are disabled on this instance.': '此实例已关闭自动 Zoom 会议。',
  'Choose the meeting organizer from the required hosts.': '请从必需主持人中选择会议组织者。',
  'Meeting organizer': '会议组织者',
  'Choose an organizer': '选择组织者',
  'Selected organizer: load the member pages to check': '已选组织者：请加载成员页面核对',
  'Choose one required host to create the Meet link. Existing bookings keep their organizer, invitation identity and original calendars.':
    '请选择一位必需主持人创建 Meet 链接。已有预约将保留原组织者、邀请身份和原日历。',
  'The assigned available host creates the Meet link. Only pool members with an eligible Google calendar can receive new bookings.':
    '实际分配的可用主持人创建 Meet 链接。只有具备符合条件的 Google 日历的池成员才能接收新预约。',
  'The organizer needs an owned, Meet-capable Google calendar. Other hosts can receive invitations without connecting a calendar. Configured Google calendars get ordinary copies after the link is ready.':
    '组织者需要拥有支持 Meet 的 Google 日历。其他主持人无需连接日历也可接收邀请；已配置的 Google 日历将在链接就绪后获得普通副本。',
  'My calendar copy': '我的日历副本',
  'No calendar copy was configured when this booking was created. Your invitation still arrives by email. Connecting a calendar later does not add a copy to this meeting.':
    '创建此预约时未配置日历副本。您仍会通过邮件收到邀请。之后连接日历不会为此会议新增副本。',
  'Your original calendar copy is up to date.': '您的原日历副本已更新。',
  'Your calendar copy is waiting for the ready meeting link or a calendar update.':
    '您的日历副本正在等待会议链接就绪或日历更新。',
  'Your calendar copy needs attention. The shared meeting link is unaffected; this meeting will not switch calendars.':
    '您的日历副本需要处理。共享会议链接不受影响；此会议不会改用其他日历。',
  'Google may have accepted this copy. Rechecking only looks for the existing copy and never imports another after an unknown result.':
    'Google 可能已接受此副本。重新检查只查找已有副本；结果未知时不会再次导入。',
  'Could not check or retry your calendar copy. Your booking has not been changed.':
    '无法检查或重试您的日历副本。您的预约未更改。',
  'Recheck my calendar copy': '重新检查我的日历副本',
  'Check my calendar copy status': '检查我的日历副本状态',

  Retry: '重试',
  'Working…': '正在处理…',
  'Conference accounts': '会议账号',
  'Zoom account connected.': 'Zoom 账号已连接。',
  'Zoom was not connected because you cancelled authorization.': '你已取消授权，Zoom 未连接。',
  'This Zoom connection attempt expired or was already used. Start again.':
    '此次 Zoom 连接尝试已过期或已使用。请重新开始。',
  'Zoom connections are not configured on this instance.': '此实例尚未配置 Zoom 连接。',
  'Zoom could not be reached. Check the connection status before trying again.':
    '无法连接 Zoom。请检查连接状态后再试。',
  'Reconnect this Zoom account before refreshing it.': '请先重新连接此 Zoom 账号，再刷新。',
  'Zoom account operations are busy. Try again shortly.': 'Zoom 账号操作繁忙。请稍后重试。',
  'Choose the same Zoom account when reconnecting this connection.':
    '重新连接时，请选择同一个 Zoom 账号。',
  'This Zoom identity is already connected to another Hourmere account.':
    '此 Zoom 身份已连接到另一个 Hourmere 账号。',
  'This account has reached its limit of five connected Zoom identities.':
    '此账号已达到同时连接五个 Zoom 身份的上限。',
  'Sign in again to manage conference accounts.': '请重新登录以管理会议账号。',
  Connected: '已连接',
  'Refreshing connection': '正在刷新连接',
  'Reconnection required': '需要重新连接',
  Disconnected: '已断开',
  'Zoom account refreshed.': 'Zoom 账号已刷新。',
  'Local Zoom access disconnected.': '本地 Zoom 访问已断开。',
  'Loading conference accounts…': '正在加载会议账号…',
  'Connecting to Zoom…': '正在连接 Zoom…',
  'Connect Zoom': '连接 Zoom',
  'Connect up to five Zoom identities at once. Disconnecting frees a place and keeps the connection ID for a future reconnection.':
    '最多同时连接五个 Zoom 身份。断开会释放名额，并保留连接编号以供今后重新连接。',
  'A Zoom authorization attempt is pending. It expires after ten minutes. Starting again replaces the oldest pending attempt when the limit is reached.':
    '有一项 Zoom 授权正在等待完成，将在十分钟后过期。达到上限后，重新开始会替换最早的待完成尝试。',
  'No Zoom accounts connected.': '尚未连接 Zoom 账号。',
  'Zoom account': 'Zoom 账号',
  'Connection updated': '连接更新时间',
  'Reconnect Zoom': '重新连接 Zoom',
  'Refresh Zoom account': '刷新 Zoom 账号',
  'Disconnect Zoom': '断开 Zoom',
  'Disconnect local Zoom access? Pending authorization attempts will also be cancelled. Remove the app separately in Zoom to revoke its grant.':
    '确定断开本地 Zoom 访问吗？待完成的授权尝试也将被取消。要撤销应用授权，请另行在 Zoom 中移除应用。',
  'Could not disconnect Zoom.': '无法断开 Zoom。',
  'Disconnecting removes local credentials. The retained account record keeps its identity and does not revoke the app in Zoom. Deleting your Hourmere account also removes the stored identity details.':
    '断开会删除本地凭据。保留的账号记录仍包含身份信息，且不会撤销 Zoom 中的应用授权。删除 Hourmere 账号也会删除已存储的身份信息。',
  'This Zoom refresh could not be confirmed. Reconnect the account.':
    '无法确认此次 Zoom 刷新结果。请重新连接账号。',
  'This Zoom connection is not available.': '此 Zoom 连接不可用。',
  'Activate round robin to get a public booking link.': '请先激活轮询，以获取公开预约链接。',
  'Round robin: one available host': '轮询：分配一位可用主持人',
  'Choose one individual host, two to eight collective hosts, or one to eight round-robin pool members. Changes affect new bookings; existing meetings retain their original hosts.':
    '单人会议选择一位主持人，集体会议选择两至八位，轮询池选择一至八位。更改只影响新预约；已有会议保留原主持人。',
  'Host pool': '主持人池',
  'Remove selected host {0}': '移除已选主持人{0}',
  'Choose one to eight pool members.': '请选择一至八位主持人池成员。',
  'Choose one to eight pool members to get a round-robin booking link.':
    '请选择一至八位主持人池成员，以获取轮询预约链接。',
  'Round-robin activation': '轮询激活',
  'Needs activation': '待激活',
  'Activate round robin': '激活轮询',
  'Activating…': '正在激活…',
  'Round robin activated.': '轮询已激活。',
  'Save the pool first, then activate it here. Saving changes never activates a dormant pool.':
    '请先保存主持人池，再在此激活。保存更改不会自动激活尚未激活的主持人池。',
  'Save your changes before using these actions.': '使用这些操作前，请先保存更改。',
  'Use hosts’ default availability': '使用主持人的默认可用时间',
  'Using default availability…': '正在使用默认可用时间…',
  'Default availability saved. Activate round robin separately when ready.':
    '默认可用时间已保存。准备好后，请单独激活轮询。',
  'This uses each selected host’s current default availability. Activation is a separate action.':
    '此操作将使用每位已选主持人当前的默认可用时间。激活需要单独操作。',
  'Could not update round robin. {0}': '无法更新轮询。{0}',
  'Each pool member uses their current default availability. An available member is assigned when someone books.':
    '每位池成员使用当前的默认可用时间；有人预约时，将分配一位可用成员。',

  ', from': '，从',
  ', through {0}': '，通过{0}',
  ', until': '，至',
  ', your personal organization': '（你的个人组织）',
  'Use only lowercase letters, digits and hyphens, up to {count} characters.':
    '只能用小写字母、数字和连字符，最多{count}个字符。',
  '. If this address can sign in, check your inbox for a link. It works once and expires in a few minutes.':
    '。如果此邮箱可以登录，请检查收件箱中的登录链接。链接仅可使用一次，几分钟后过期。',
  '. They are saved right away.': '。更改会立即保存。',
  '”? Anything using it stops working at once. This cannot be undone.':
    '”？使用此密钥的应用会立即失效，且无法撤销。',
  '(opens in a new tab)': '（在新标签页打开）',
  '(personal)': '（个人）',
  'A language tag such as en, en-GB or pt-BR': '语言标签，例如 en、en-GB 或 pt-BR',
  'A schedule that no longer exists': '已不存在的日程',
  'Access has expired or been removed. Connect this': '访问权限已过期或被移除。请重新连接此',
  Account: '账号',
  'account again to restore it.': '账号以恢复访问。',
  Actions: '操作',
  Active: '启用',
  'Active: invitees can book it': '启用：允许受邀人预约',
  'Enable this event type': '启用此活动类型',
  'Unlisted is not access control. Once this event type is bookable, anyone who knows or guesses its direct link can book it.':
    '仅限链接不代表访问控制。此活动类型开放预约后，任何知道或猜到直接链接的人都可以预约。',
  'Add a date override': '添加特定日期安排',
  'Add a question': '添加问题',
  'Add an option': '添加选项',
  'Add at least one option.': '请至少添加一个选项。',
  'Add hours': '添加时间段',
  'Add hours on {0}': '添加时间段（{0}）',
  'Add hours, or choose unavailable all day.': '请添加时间段，或选择全天不可用。',
  Added: '已添加',
  Address: '地址',
  'AI apps connected through MCP OAuth. Revoking access stops new requests immediately; completed bookings remain.':
    '通过 MCP OAuth 连接的 AI 应用。撤销访问后，新请求会立即被拒绝；已完成的预约会保留。',
  'Allow access': '允许访问',
  'Allow invitees to add guests': '允许受邀人添加来宾',
  'an agent or script (API)': '代理或脚本（API）',
  'an earlier booking': '先前的预约',
  'an embedded booking page': '嵌入的预约页面',
  'An end time of 00:00 (12:00 AM) means midnight at the end of the day.':
    '结束时间 00:00（凌晨 12 点）表示当日结束的午夜。',
  'An https:// or http:// link, e.g. to your video room.':
    'https:// 或 http:// 链接，例如你的视频会议室地址。',
  'An organization you have left': '已退出的组织',
  'Another of your event types already uses this link. Choose another.':
    '你的其他活动类型已使用此链接。请选择另一个。',
  'Answer type': '回答类型',
  Answers: '回答',
  'API keys let AI agents and scripts use Hourmere for you, through the same API as this app. Each key acts in one organization and can do anything you can do there, so treat it like a password.':
    'API 密钥允许 AI 代理和脚本通过与本应用相同的 API 代表你使用 Hourmere。每个密钥在一个组织中生效，拥有你在该组织中的全部操作权限，请像密码一样保管。',
  'Approve connection': '批准连接',
  'Ask at most {0} questions.': '最多提出{0}个问题。',
  'availability page': '可预约时间页面',
  'Back to availability': '返回可预约时间',
  'Back to bookings': '返回预约列表',
  'Back to event types': '返回活动类型',
  Basics: '基本信息',
  Booked: '已预约',
  'Booking calendar saved. New bookings use this destination; existing meetings keep theirs.':
    '预约日历已保存。新预约将使用此日历；现有会议保持原日历。',
  'Booking form': '预约表单',
  'Booking link': '预约链接',
  'Booking not found': '找不到预约',
  'Booking window': '可预约范围',
  'Bookings are shown in this zone. Type to search, e.g. “Berlin”.':
    '预约以此时区显示。输入城市搜索，例如“上海”。',
  'Bookings per day, {0}–{1}. Empty: no limit.': '每天的预约数量，{0}–{1}。留空表示不限。',
  'Buffer after': '会后缓冲',
  'Buffer before': '会前缓冲',
  'Calendar list refreshed.': '日历列表已刷新。',
  'Cancel booking…': '取消预约…',
  'Cancel this booking': '取消此预约',
  Cancelled: '已取消',
  'Check this calendar for conflicts': '检查此日历的冲突',
  'Write new bookings here': '将新预约写入此日历',
  'Stop writing bookings here': '停止向此日历写入预约',
  'Sync now': '立即同步',
  '{0} Calendar connected. Your calendar list is ready.': '{0}日历已连接。日历列表已就绪。',
  '{0} Calendar was not connected because you cancelled authorization.':
    '你已取消授权，因此未连接{0}日历。',
  '{0} did not grant the requested access. Connect again and allow the requested permissions.':
    '{0}未授予所需权限。请重新连接并允许请求的权限。',
  '{0} did not provide continuing access. Connect again to try again.':
    '{0}未提供持续访问权限。请重新连接后重试。',
  '{0} Calendar could not be reached. Try connecting again shortly.':
    '暂时无法连接{0}日历。请稍后重新连接。',
  '{0} Calendar disconnected. Stored credentials and local calendar data were deleted.':
    '{0}日历已断开连接。保存的凭据和本地日历数据已删除。',
  'Create a profile before choosing where new bookings are written.':
    '请先创建个人资料，再选择用于写入新预约的日历。',
  'Create your profile in Settings first.': '请先在“设置”中创建个人资料。',
  'Check your calendar settings and try again.': '请检查日历设置后重试。',
  'Choose calendar-list access or calendar synchronization.': '请选择日历列表访问或日历同步权限。',
  'This calendar connection no longer exists.': '此日历连接已不存在。',
  'This calendar is no longer available. Refresh the calendar list.':
    '此日历已不可用。请刷新日历列表。',
  'Select at most 20 conflict calendars.': '最多可选择 20 个用于检查冲突的日历。',
  'This calendar does not allow event synchronization.': '此日历不允许同步事件。',
  'Select this calendar for conflict checks before synchronizing it.':
    '请先选择此日历用于检查冲突，再进行同步。',
  'Choose an owned Google calendar and enable synchronization first.':
    '请先选择你拥有的 Google 日历并启用同步。',
  'Google Calendar could not be reached. Try again shortly.': '无法连接 Google 日历。请稍后重试。',
  'Microsoft Calendar could not be reached. Try again shortly.':
    '无法连接 Microsoft 日历。请稍后重试。',
  'Reconnect Microsoft Calendar to restore access.': '请重新连接 Microsoft 日历以恢复访问。',
  'Reconnect Microsoft Calendar and allow the requested permissions.':
    '请重新连接 Microsoft 日历并允许请求的权限。',
  'Check that it works:': '检查是否可用：',
  'Check these hours: each must end after it starts.':
    '请检查这些时间段：每段的结束时间必须晚于开始时间。',
  'Check your email': '查看邮件',
  Checkbox: '复选框',
  'Checking the connection request…': '正在检查连接请求…',
  'Choose a date in the years 0001 to 9999.': '请选择 0001 至 9999 年之间的日期。',
  'Choose a date.': '请选择日期。',
  'Choose a handle to get booking links. Check the suggestions below and save.':
    '请选择用户名以获得预约链接。请查看下方建议并保存。',
  'Choose a non-reserved team slug of 1–64 letters, numbers or hyphens, starting and ending with a letter or number.':
    '请选择未被保留的团队标识，使用 1–64 个字母、数字或连字符，首尾须为字母或数字。',
  'Choose a time zone from the list, e.g. Europe/Berlin.':
    '请从列表中选择时区，例如 Europe/Berlin。',
  'Choose a time zone.': '请选择时区。',
  'Choose an organization': '选择组织',
  'Choose calendars whose busy times block bookings, and an owned calendar for new booking events. Existing meetings keep their original calendar when you change the destination.':
    '选择用于检查忙闲冲突的日历，以及用于创建新预约事件的自有日历。更改目标日历后，现有会议仍保留在原日历中。',
  'Choose your handle in Settings to get booking links.': '请在设置中选择用户名，以获得预约链接。',
  'Client:': '客户端：',
  Confirmed: '已确认',
  'Conflict calendar selection saved.': '冲突日历选择已保存。',
  'Connect an AI app': '连接 AI 应用',
  'Connect Google Calendar': '连接 Google 日历',
  'Connect Microsoft Calendar': '连接 Microsoft 日历',
  'Connected accounts': '已连接的账号',
  Continue: '继续',
  'Continuing…': '正在继续…',
  'Copy command': '复制命令',
  'Copy key': '复制密钥',
  'Copy link for {0}': '复制链接：{0}',
  'Copy your new key “{name}”': '复制新密钥“{name}”',
  'Could not cancel the booking. {0}': '无法取消预约。{0}',
  'Could not check your session. Please reload.': '无法检查登录状态。请刷新页面。',
  'Could not connect {0} Calendar. {1}': '无法连接{0}日历。{1}',
  "Could not create the key: you can't create keys in {0}.":
    '无法创建密钥：你不能在{0}中创建密钥。',
  'Could not create the key. {0}': '无法创建密钥。{0}',
  'Could not delete the event type.': '无法删除活动类型。',
  'Could not delete the schedule.': '无法删除日程。',
  'Could not disconnect {0} Calendar.': '无法断开{0}日历。',
  'Could not load more bookings. {0}': '无法加载更多预约。{0}',
  'Could not load the booking.': '无法加载预约。',
  'Could not load the event type.': '无法加载活动类型。',
  'Could not load the schedule.': '无法加载日程。',
  'Could not load your bookings.': '无法加载你的预约。',
  'Could not load your event types.': '无法加载你的活动类型。',
  'Could not load your keys.': '无法加载你的密钥。',
  'Could not load your profile.': '无法加载你的个人资料。',
  'Could not load your schedules.': '无法加载你的日程。',
  'Could not make it the default. {0}': '无法设为默认日程。{0}',
  'Could not remove it. {0}': '无法移除。{0}',
  'Could not revoke the key. {0}': '无法撤销密钥。{0}',
  'Could not save the event type. {0}': '无法保存活动类型。{0}',
  'Could not save the schedule. {0}': '无法保存日程。{0}',
  'Could not save your display name. {0}': '无法保存显示名称。{0}',
  'Could not save your profile. {0}': '无法保存个人资料。{0}',
  'Could not send the link. {0}': '无法发送登录链接。{0}',
  'Could not start sign-in. {0}': '无法开始登录。{0}',
  'Create a key': '创建密钥',
  'Create event type': '创建活动类型',
  'Create key': '创建密钥',
  'Create profile': '创建个人资料',
  'Create schedule': '创建日程',
  'Create the schedule first; then you can change the hours of single dates, such as holidays.':
    '请先创建日程；然后便可修改节假日等特定日期的时间安排。',
  'Create your first event type': '创建第一个活动类型',
  Created: '创建时间',
  'Created “{0}”.': '已创建“{0}”。',
  'Creating…': '正在创建…',
  'Weekly limit': '每周上限',
  'Monthly limit': '每月上限',
  'Bookings per week, {0}–{1}. Empty: no limit.': '每周的预约数量，{0}–{1}。留空表示不限。',
  'Bookings per month, {0}–{1}. Empty: no limit.': '每月的预约数量，{0}–{1}。留空表示不限。',
  'Weekly limit must be at least the daily limit.': '每周上限不得低于每日上限。',
  'Monthly limit must be at least the weekly limit.': '每月上限不得低于每周上限。',
  'Monthly limit must be at least the daily limit.': '每月上限不得低于每日上限。',
  'Booking limits changed elsewhere. Reload to see the current limits before saving again. Your changes have not been saved.':
    '预约上限已在其他地方更改。请重新加载查看当前上限后再保存。你的更改尚未保存。',
  'Daily limit': '每日上限',
  Date: '日期',
  'Date overrides': '特定日期安排',
  'Days ahead people can book, {0}–{1}. Empty: no limit.':
    '可提前预约的天数，{0}–{1}。留空表示不限。',
  Default: '默认',
  'Delete “{0}”? This cannot be undone.': '删除“{0}”？此操作无法撤销。',
  'Delete event type': '删除活动类型',
  'Delete schedule': '删除日程',
  'Delete this event type': '删除此活动类型',
  'Delete this schedule': '删除此日程',
  'Deleted “{0}”.': '已删除“{0}”。',
  'Deleting…': '正在删除…',
  Deny: '拒绝',
  Description: '描述',
  Disabled: '已禁用',
  Disconnect: '断开连接',
  'Disconnect {0}': '断开连接：{0}',
  'Disconnect {0}? This deletes stored credentials and local calendar data. You can also remove Hourmere’s access in {1} account settings.':
    '断开{0}？此操作将删除已保存的凭据和本地日历数据。你也可以在{1}账号设置中移除 Hourmere 的访问权限。',
  'Disconnect account': '断开账号连接',
  'Disconnecting…': '正在断开连接…',
  'Display name': '显示名称',
  'Display name saved.': '显示名称已保存。',
  Duration: '时长',
  Edit: '编辑',
  'Edit “{0}”': '编辑“{0}”',
  'Edit {0}': '编辑{0}',
  'Edit display name': '编辑显示名称',
  'Edit event type': '编辑活动类型',
  'Edit schedule': '编辑日程',
  'Email me a sign-in link': '通过邮件发送登录链接',
  'Empty: {0}.': '留空：{0}。',
  'Enable calendar synchronization': '启用日历同步',
  'End after the start time.': '结束时间须晚于开始时间。',
  'Enter a full link starting with https:// or http://.':
    '请输入以 https:// 或 http:// 开头的完整链接。',
  'Enter a handle.': '请输入用户名。',
  'Enter a language tag such as en, en-GB or pt-BR.': '请输入语言标签，例如 en、en-GB 或 pt-BR。',
  'Enter a link starting with https:// or http://.': '请输入以 https:// 或 http:// 开头的链接。',
  'Enter a name on one line, up to {0} characters.': '请输入单行姓名，最多{0}个字符。',
  'Enter a start time.': '请输入开始时间。',
  'Enter an address of up to 500 characters on one line.': '请输入单行地址，最多 500 个字符。',
  'Enter an end time.': '请输入结束时间。',
  'Enter an http or https link of up to 2000 characters.':
    '请输入 http 或 https 链接，最多 2000 个字符。',
  'Enter the last part of the booking link.': '请输入预约链接的最后一部分。',
  'Enter the link.': '请输入链接。',
  'Enter the number in international format, e.g. +14155550123.':
    '请输入国际格式的电话号码，例如 +14155550123。',
  Event: '活动',
  'Event type not found': '找不到活动类型',
  'event types': '活动类型',
  'Event types that use it switch to your default schedule.':
    '使用此日程的活动类型将改为使用你的默认日程。',
  'Event types use this schedule only where you choose it.': '仅在活动类型中明确选择此日程时使用。',
  'Event types use this schedule unless you choose another one for them.':
    '活动类型默认使用此日程，除非另行选择。',
  Expired: '已过期',
  Expires: '到期时间',
  'For example “Intro call”.': '例如“初次通话”。',
  'For you only, e.g. “Working hours”.': '仅供你查看，例如“工作时间”。',
  'Free time kept after each meeting.': '每次会议后保留的空闲时间。',
  'Free time kept before each meeting.': '每次会议前保留的空闲时间。',
  Fri: '周五',
  Friday: '星期五',
  'Google Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.':
    '此 Hourmere 实例尚未配置 Google 日历。请联系管理员启用。',
  'Google will ask for your email, calendar list and event access: to check busy times on selected calendars, and to create one private copy of each new booking on the calendar you own and select. Changing this destination affects new bookings; existing booking copies continue to be updated or cancelled on their original calendar. Automatic Google Meet adds a link only when you enable it. Busy-time synchronization stores times and event IDs, not event titles or descriptions. Connecting is optional and separate from signing in.':
    'Google 将请求你的邮箱、日历列表和事件访问权限：读取所选日历的忙闲时间来检查冲突，并在你拥有且选作写入目标的日历中，为每个新预约创建一份私有副本。更改写入目标只影响新预约；现有预约的副本仍会在原日历中更新或取消。只有启用自动 Google Meet 时才会添加会议链接。忙闲同步保存时间和事件 ID，不保存事件标题或描述。连接日历是可选的，与登录相互独立。',
  'Google Account connections': 'Google 账号连接',
  'Could not load privacy information. Try again before connecting Google Calendar.':
    '无法加载隐私信息。请重试后再连接 Google 日历。',
  'Could not load your profile. Try again before choosing where new bookings are written.':
    '无法加载个人资料。请重试后再选择用于写入新预约的日历。',
  'Guests receive confirmation emails and calendar invitations. Off by default; changing this does not remove guests from existing bookings.':
    '来宾会收到确认邮件和日历邀请。默认关闭；更改此项不会移除现有预约的来宾。',
  Handle: '用户名',
  'Hide from your booking page': '在预约主页中隐藏',
  Hours: '时间段',
  'Hours {0}, from': '时间段{0}，从',
  'Hours {0}, until': '时间段{0}，至',
  'How far ahead a meeting must be booked.': '会议至少需要提前多久预约。',
  'I’ve saved my key': '我已保存密钥',
  'In 1 year': '1 年后',
  'In 30 days': '30 天后',
  'In 90 days': '90 天后',
  'In international format, e.g. +14155550123. Invitees see it after booking.':
    '使用国际格式，例如 +14155550123。受邀人在预约后可见。',
  Inactive: '未启用',
  Invitee: '受邀人',
  'Invitees always give their name and email. Add questions for anything else you need to know, up to {count}.':
    '受邀人始终需要提供姓名和邮箱。你还可以添加最多{count}个问题。',
  'It can stay connected after you sign out, for up to 30 days from its original approval. Refreshing does not extend that time. Leaving the organization or revoking access in Connected apps stops the connection immediately.':
    '此应用可在你退出登录后继续连接，最长为首次批准起的 30 天。刷新令牌不会延长此期限。离开组织或在“已连接的应用”中撤销访问会立即终止连接。',
  'Its booking link stops working at once. Bookings already made are kept, and you can still see them under Bookings.':
    '预约链接会立即失效。已创建的预约会保留，你仍可在预约列表中查看。',
  'Its date overrides are deleted with it.': '对应的特定日期安排也将删除。',
  Language: '语言',
  'Last synchronized: {0}': '上次同步：{0}',
  'Last used': '上次使用',
  'Links you have already shared will stop working.': '此前分享的链接将失效。',
  'Loading bookings…': '正在加载预约…',
  'Loading calendars…': '正在加载日历…',
  'Loading event types…': '正在加载活动类型…',
  'Loading keys…': '正在加载密钥…',
  'Loading schedules…': '正在加载日程…',
  'Loading the booking…': '正在加载预约…',
  'Loading your profile…': '正在加载个人资料…',
  Location: '地点',
  'Long text': '长文本',
  'Lower numbers come first on your booking page.': '数值较小的活动在预约主页中排在前面。',
  'Lowercase letters, digits and hyphens.': '使用小写字母、数字和连字符。',
  'Lowercase letters, digits and hyphens. {0}': '使用小写字母、数字和连字符。{0}',
  'Make default': '设为默认',
  'Make default: {0}': '设为默认：{0}',
  'Make this my default schedule': '设为我的默认日程',
  'Manage schedules': '管理日程',
  'Meeting link': '会议链接',
  'Microsoft Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.':
    '此 Hourmere 实例尚未配置 Microsoft 日历。请联系管理员启用。',
  'Microsoft will ask for your account identity, continuing access and permission to read basic calendar details. This connection lists your calendars; busy-time synchronization and booking event writes are not yet available. Connecting is separate from signing in.':
    'Microsoft 将请求你的账号标识、持续访问权限以及读取基本日历信息的权限。此连接用于列出日历；忙闲同步和写入预约事件尚不可用。连接日历与登录相互独立。',
  'Minimum notice': '最短提前预约时间',
  Mon: '周一',
  Monday: '星期一',
  'Move down': '下移',
  'Move down: {0}': '下移：{0}',
  'Move up': '上移',
  'Move up: {0}': '上移：{0}',
  'Moved {0} to position {1} of {2}.': '已将{0}移至第{1}位，共{2}项。',
  'Must be ticked to book': '须勾选才能预约',
  Name: '名称',
  'Name and time zone': '名称和时区',
  Never: '永不到期',
  'Never used': '从未使用',
  'New API key': '新 API 密钥',
  'New event type': '新活动类型',
  'New schedule': '新日程',
  'Newest first.': '最新的排在前面。',
  No: '否',
  'No answers to extra questions.': '没有额外问题的回答。',
  'No calendar accounts connected yet.': '尚未连接日历账号。',
  'No calendars found in this account.': '此账号中未找到日历。',
  'No connected apps.': '没有已连接的应用。',
  'No extra questions.': '没有额外问题。',
  'No hours set': '尚未设置时间段',
  'No hours: unavailable.': '没有时间段：不可用。',
  'No password needed. New account registration depends on this instance’s settings.':
    '无需密码。能否创建新账号取决于此实例的注册设置。',
  'No past bookings yet.': '尚无过去的预约。',
  'No public booking link': '没有公开预约链接',
  'No upcoming bookings.': '没有即将到来的预约。',
  None: '无',
  'Not set': '未设置',
  'Offer at most {0} options.': '最多提供{0}个选项。',
  'Only approve apps you trust. The app name and return address are supplied by the app.':
    '仅批准你信任的应用。应用名称和返回地址均由该应用提供。',
  'OpenAPI document': 'OpenAPI 文档',
  'Opening Google…': '正在打开 Google…',
  'Opening Microsoft…': '正在打开 Microsoft…',
  Option: '选项',
  'Options for question {number}': '问题{number}的选项',
  'Option {option} of question {number}': '问题{number}的选项{option}',
  Organization: '组织',
  'Organization to connect': '要连接的组织',
  'Organization:': '组织：',
  'Other video or meeting link': '其他视频或会议链接',
  Past: '过去',
  'Past bookings': '过去的预约',
  People: '人员',
  'Personal organization': '个人组织',
  'Phone number': '电话号码',
  'Pick one (dropdown)': '单选（下拉列表）',
  'Pick several': '多选',
  Position: '排序位置',
  Profile: '个人资料',
  'Profile created. Your booking links are ready.': '个人资料已创建。你的预约链接已就绪。',
  'Question {0}': '问题{0}',
  Questions: '问题',
  'Reason:': '原因：',
  'Refresh calendar list': '刷新日历列表',
  'Synchronizing busy times…': '正在同步忙碌时段…',
  Remove: '移除',
  'Remove {0}': '移除{0}',
  'Remove option {0}{1}, of question {2}': '移除问题{2}的选项{0}{1}',
  'Remove override: {0}': '移除特定日期安排：{0}',
  'Remove question': '移除问题',
  'Remove question: {0}': '移除问题：{0}',
  'Remove special control characters (tabs and line breaks are fine).':
    '请移除特殊控制字符（可保留制表符和换行符）。',
  'Removed question {0}{1}.': '已移除问题{0}{1}。',
  'Removing…': '正在移除…',
  Replaced: '已替换',
  Required: '必填',
  'Reschedule this booking': '为此预约改期',
  'Choose a new time. The invitee and hosts will be notified.':
    '选择新的时间。系统会通知受邀人和主持人。',
  'The booking is moved to the new time.': '预约已移至新时间。',
  'The response was lost. The booking may have moved. Check your bookings before trying again.':
    '未收到响应。预约可能已改期。再次尝试前请先查看预约列表。',
  Rescheduled: '已改期',
  'View rescheduled booking': '查看改期后的预约',
  'Return address:': '返回地址：',
  Revoke: '撤销',
  'Revoke “': '撤销“',
  'Revoke {0}': '撤销{0}',
  'Revoke access': '撤销访问',
  'Revoke key': '撤销密钥',
  'Revoked “{0}”.': '已撤销“{0}”。',
  'Revoking…': '正在撤销…',
  Sat: '周六',
  Saturday: '星期六',
  'Save changes': '保存更改',
  'Save display name': '保存显示名称',
  'Save profile': '保存个人资料',
  'Saved.': '已保存。',
  'Saving…': '正在保存…',
  Schedule: '日程',
  'Schedule not found': '找不到日程',
  'Schedules are the weekly hours people can book you in. Event types use your default schedule unless you choose another one for them.':
    '日程规定每周可预约你的时间。活动类型默认使用你的默认日程，除非为其另选日程。',
  'Send the key as a bearer token. For example, this shows which account and organization a key acts for:':
    '将密钥作为 Bearer 令牌发送。例如，以下命令可查看密钥代表的账号和组织：',
  'Sending…': '正在发送…',
  'Set your availability': '设置可预约时间',
  'Set your time zone': '设置时区',
  'Set your weekly hours': '设置每周时间段',
  'Share the links of your {0} so people can book you.': '分享你的{0}，以便他人预约你。',
  'Short text': '短文本',
  'Show more bookings': '显示更多预约',
  'Showing {0} bookings.': '共显示{0}个预约。',
  'Shown on booking pages, in emails and in calendar invitations.':
    '显示在预约页面、邮件和日历邀请中。',
  'Shown on the booking page. Line breaks are kept.': '显示在预约页面上。保留换行。',
  'Sign in again, then start a new calendar connection.': '请重新登录，然后开始新的日历连接。',
  'Sign in to Hourmere': '登录 Hourmere',
  'Sign in with an email link instead.': '请改用邮件链接登录。',
  'Sign-in did not work{0}. Please try again.': '登录失败{0}。请重试。',
  'Sign-in was cancelled.': '已取消登录。',
  'Signed in as': '当前登录账号',
  'Start times every': '开始时间间隔',
  'Store it somewhere safe, such as a password manager or your agent’s secret settings. If you lose it, revoke it and create a new one.':
    '请将密钥保存在安全的地方，例如密码管理器或代理的密钥设置中。若密钥丢失，请撤销并创建新密钥。',
  Sun: '周日',
  Sunday: '星期日',
  'Synchronization failed. Booking times stay unavailable until synchronization recovers.':
    '同步失败。在同步恢复之前，相关时间将保持不可预约。',
  "That account's email address does not match yours. {0}": '该账号的邮箱与你的邮箱不符。{0}',
  'That date': '该日期',
  'That sign-in account is already connected to another Hourmere account. {0}':
    '该登录账号已连接至另一个 Hourmere 账号。{0}',
  'That sign-in attempt expired or was interrupted. Please try again.':
    '该登录尝试已过期或被中断。请重试。',
  'That sign-in link has expired. Request a new one below.':
    '该登录链接已过期。请在下方获取新链接。',
  'That sign-in link is invalid, has expired or was already used. Request a new one below.':
    '该登录链接无效、已过期或已使用。请在下方获取新链接。',
  'The API is described in its': 'API 说明参见',
  'The booking is cancelled.': '预约已取消。',
  'the booking page': '预约页面',
  'The hours below are in this zone. Type to search, e.g. “Berlin”.':
    '下方时间段使用此时区。输入城市搜索，例如“上海”。',
  'The invitee can see it. Up to {0} characters.': '受邀人可见。最多{0}个字符。',
  'The key will act in': '密钥将作用于',
  'The kinds of meetings people can book with you, each with its own link.':
    '可供他人预约的会议类型，每种类型有独立链接。',
  'The time becomes free again. The invitee can see that it is cancelled, and why if you give a reason, with their booking.':
    '该时间将恢复空闲。受邀人可在预约中看到取消状态，以及你填写的取消原因。',
  'The weekly hours times are offered in. {0}': '用于提供每周时间段的时区。{0}',
  'These hours overlap: {0}.': '以下时间段重叠：{0}。',
  'This app can use MCP tools with your permissions in this organization: view event types and availability, and create, view, reschedule or cancel bookings. It receives booking details, including attendee information and answers. It cannot manage your account or API keys.':
    '此应用可在该组织中以你的权限使用 MCP 工具：查看活动类型和可用时间，以及创建、查看、改期或取消预约。应用将收到预约详情，包括参会人信息和回答。它无法管理你的账号或 API 密钥。',
  'This booking can no longer be cancelled. It may have started or become unavailable.':
    '此预约已无法取消，可能已开始或已不可用。',
  'This booking does not exist, or it is not one of yours.': '此预约不存在，或不属于你。',
  'This booking has already started, so it can no longer be cancelled.': '此预约已开始，无法取消。',
  'This booking was already cancelled. Reload to see the details.':
    '此预约已被取消。请刷新查看详情。',
  'This connection attempt expired or was already used. Start again.':
    '此连接尝试已过期或已使用。请重新开始。',
  'This connection attempt was interrupted. Restart it from your AI app.':
    '此连接尝试被中断。请从 AI 应用重新开始。',
  'This connection has calendar-list access only. Enable synchronization to use busy times and write booking events.':
    '此连接只有日历列表访问权限。启用同步后，方可检查忙闲时间和写入预约事件。',
  'This connection lists calendars only. Busy-time synchronization and booking writes are not yet available.':
    '此连接仅用于列出日历。忙闲同步和写入预约事件暂不可用。',
  'This email address already has an account. {0}': '此邮箱已有账号。{0}',
  'This event type does not exist, or it was deleted.': '此活动类型不存在，或已被删除。',
  'This handle is already taken. Choose another one.': '此用户名已被占用。请选择另一个。',
  'This handle is reserved. Choose another one.': '此用户名已被保留。请选择另一个。',
  'This Hourmere instance does not accept new accounts for that email address.':
    '此 Hourmere 实例不允许该邮箱创建新账号。',
  'This is not a time zone the server knows. Choose one from the list.':
    '服务器不识别此时区。请从列表中选择。',
  'This is your only schedule: without it, your event types offer no times.':
    '这是你唯一的日程：删除后，活动类型将不再提供可预约时间。',
  'This option is already in the list.': '列表中已有此选项。',
  'This schedule does not exist, or it was deleted.': '此日程不存在，或已被删除。',
  'This schedule no longer exists. Choose another one.': '此日程已不存在。请选择其他日程。',
  'This sign-in could not be connected to your account. {0}': '无法将此登录方式连接至你的账号。{0}',
  Thu: '周四',
  Thursday: '星期四',
  'Time zone:': '时区：',
  'Time zone: {zone}': '时区：{zone}',
  ' ({time} there)': '（{time}，当地时间）',
  'Times are in {zone}, your time zone.': '时间使用以下时区：{zone}（你的时区）。',
  'Times are in {zone}, this browser’s time zone. {0}.':
    '时间使用以下时区：{zone}（此浏览器的时区）。{0}。',
  'Shown in this browser’s time zone. {0}.': '以此浏览器的时区显示。{0}。',
  'You have no schedule yet, so no times are offered. {0}.':
    '你尚无日程，因此没有可预约时间。{0}。',
  'This is your default schedule. To delete it, first make another schedule the default on the {0}.':
    '这是你的默认日程。如需删除，请先在以下页面将其他日程设为默认：{0}。',
  '{0}, so there are times to book.': '{0}，这样才会有可预约时间。',
  Title: '标题',
  Tue: '周二',
  Tuesday: '星期二',
  Unavailable: '不可用',
  'Unavailable all day': '全天不可用',
  Unlisted: '仅限链接',
  Unnamed: '未命名',
  'Unsaved changes': '未保存的更改',
  'Up to {0} characters on one line.': '最多{0}个字符，限单行。',
  Upcoming: '即将到来',
  'Upcoming bookings': '即将到来的预约',
  'Resend link': '重新发送链接',
  'Change email': '更换邮箱',
  'Resending…': '正在重新发送…',
  'We received your new sign-in link request. Check your inbox if this address can sign in.':
    '我们已收到新的登录链接请求。如果此邮箱可以登录，请检查收件箱。',
  'Too many requests. Please wait and try again later.': '请求过多，请稍后重试。',
  'Could not resend the link. Please try again.': '无法重新发送链接，请重试。',
  'Use a link of at most {0} characters.': '链接最多{0}个字符。',
  'Use a link without spaces or control characters.': '链接不能包含空格或控制字符。',
  'Use at most 1000 characters, without control characters other than tabs and line breaks.':
    '最多 1000 个字符，除制表符和换行符外不能包含控制字符。',
  'Use at most 5000 characters, without control characters other than tabs and line breaks.':
    '最多 5000 个字符，除制表符和换行符外不能包含控制字符。',
  'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.':
    '请使用小写字母、数字和连字符，首尾须为字母或数字。',
  'Use one line of up to 100 characters.': '请使用单行文字，最多 100 个字符。',
  'Use one line of up to 200 characters without control characters.':
    '请使用单行文字，最多 200 个字符，且不含控制字符。',
  'Using a key': '使用密钥',
  'Synchronization is not ready yet. Booking times stay unavailable until it completes.':
    '同步数据尚未就绪。同步完成前，相关时间将保持不可预约。',
  'wants to connect to Hourmere.': '希望连接至 Hourmere。',
  'We received your sign-in link request for': '我们已收到此邮箱的登录链接请求：',
  Wed: '周三',
  Wednesday: '星期三',
  'Weekly hours': '每周时间段',
  'When people can book': '何时可预约',
  'Where the key will be used, e.g. “Claude Desktop”.': '密钥的使用位置，例如“Claude Desktop”。',
  'Where the meeting happens': '会议地点',
  'Working hours': '工作时间',
  Yes: '是',
  'You could not be signed in. Please try again.': '无法登录。请重试。',
  'You have no API keys yet.': '你尚无 API 密钥。',
  'You have no event types yet. Create one to start taking bookings.':
    '你尚无活动类型。创建一个即可开始接收预约。',
  'You have no schedule yet, so your event types offer no times. Start with your working hours; you can change them any time.':
    '你尚无日程，活动类型无法提供预约时间。请先设置工作时间；以后随时可以更改。',
  'You won’t be able to see this key again.': '你将无法再次查看此密钥。',
  "You're no longer a member of {0}, so no key was created. Keys you create now act in {1}.":
    '你已不再是{0}的成员，因此未创建密钥。现在创建的密钥将作用于{1}。',
  'Your account could not be created. Please try again.': '无法创建账号。请重试。',
  'Your booking links start with {path}.': '你的预约链接以{path}开头。',
  'Your default schedule': '你的默认日程',
  'Your email comes from how you sign in.': '你的邮箱由登录方式决定。',
  'Your first schedule is your default schedule.': '你的首个日程将作为默认日程。',
  'Your keys': '你的密钥',
  'Your phone number': '你的电话号码',
  'Your schedules': '你的日程',
  'Your session ended. Please sign in again.': '你的登录已过期。请重新登录。',
  'Your sign-in provider did not confirm your email address. {0}':
    '登录服务未验证你的邮箱地址。{0}',
  'Your sign-in provider did not send your account details. Please try again.':
    '登录服务未提供你的账号信息。请重试。',
  'Your sign-in provider did not share your email address. {0}': '登录服务未提供你的邮箱地址。{0}',
  'the duration': '活动时长',
  '{0} account': '{0}账号',
  '(primary)': '（主日历）',
  'your-handle': 'your-handle',
  guest: '位来宾',
  guests: '位来宾',
  '{0} (minutes)': '{0}（分钟）',
  'Question {0} type': '问题{0}的类型',
  'Question {0} options': '问题{0}的选项',
  'Question {0}, option {1}': '问题{0}，选项{1}',
  'Newest first. ': '最新的排在前面。',
  'a title': '标题',
  'an address': '地址',
  'an option': '选项',
  'a question': '问题',
  'a name': '名称',
  'the question': '该问题',
  'question {number}': '问题{number}',
  ', “{label}”': '“{label}”',
  'question {number}, “{label}”': '问题{number}，“{label}”',
  '{label}, hours {count}': '{label}，时间段{count}',
  '{label}, hours {count}, from': '{label}，时间段{count}，从',
  '{label}, hours {count}, until': '{label}，时间段{count}，至',
  '“{name}” is now your default schedule.': '“{name}”现已设为你的默认日程。',
  Availability: '可预约时间',
  Bookings: '预约',
  Calendars: '日历',
  Cancel: '取消',
  'Connected apps': '已连接的应用',
  'Could not save': '无法保存',
  'Could not sign out. {0}': '无法退出登录。{0}',
  Dismiss: '关闭提示',
  'Enter a number from {0} to {1}.': '请输入{0}至{1}之间的数字。',
  'Enter a number.': '请输入数字。',
  'Enter a whole number.': '请输入整数。',
  'Error:': '错误：',
  'Event types': '活动类型',
  'Hourmere home': 'Hourmere 主页',
  Main: '主导航',
  'Please check the form': '请检查表单',
  Settings: '设置',
  'Sign out': '退出登录',
  'Use at most {0} characters (now {1}).': '最多{0}个字符（当前{1}个）。',
  'Use one line of text without special control characters.':
    '请使用单行文字，且不含特殊控制字符。',
  'You have unsaved changes. Leave this page and discard them?':
    '你有未保存的更改。离开此页面并放弃更改？',
  '{first} and {second}': '{first}与{second}',
  'Booking activity': '预约统计',
  'Booking actions by the day they were recorded, rather than the meeting date. These counts describe currently retained bookings; deleting data can change history.':
    '按预约操作的记录日期统计，而非会议日期。统计仅反映当前保留的预约；删除数据可能改变历史统计。',
  'Loading reporting preferences…': '正在加载统计偏好…',
  'Could not load reporting preferences.': '无法加载统计偏好。',
  'Enter a valid start date.': '请输入有效的开始日期。',
  'Enter a valid end date.': '请输入有效的结束日期。',
  'Choose at most 90 calendar days, with the end on or after the start.':
    '请选择最多 90 个日历日，且结束日期不得早于开始日期。',
  'Choose an IANA time zone.': '请选择 IANA 时区。',
  'Start date': '开始日期',
  'End date': '结束日期',
  'Reporting time zone': '统计时区',
  'Both dates are included, up to 90 local days.': '包含起止日期，最多 90 个当地日历日。',
  'Update report': '更新统计',
  'Loading booking activity…': '正在加载预约统计…',
  'Could not load booking activity.': '无法加载预约统计。',
  'Booking activity is available to personal account owners and team owners or admins. Your current team role does not permit this report.':
    '个人账号所有者，以及团队所有者或管理员可查看预约统计。你当前的团队角色无权查看此统计。',
  to: '至',
  'Reporting time zone: {0}. Days can have 23 or 25 hours when the clocks change.':
    '统计时区：{0}。夏令时切换时，一天可能有 23 或 25 小时。',
  'Bookings created': '新建预约',
  Reschedules: '改期',
  Cancellations: '取消',
  'Creations count the initial booking once. Reschedules count each move. Cancellations exclude the old booking withdrawn during a move. These are activity counts, without visitor or conversion tracking.':
    '新建预约仅计入首次预约；每次改期均计入改期次数；取消次数不包含改期时撤销的旧预约。这里只统计预约操作，不追踪访客或转化。',
  'No booking activity was recorded in this range.': '此范围内没有预约操作记录。',
  'Daily booking activity': '每日预约统计',
  Hosts: '主持人',
  Scheduling: '排期方式',
  'Individual: one host': '单人会议：一位主持人',
  'Collective: every selected host is required': '集体会议：所有选中的主持人都必须参加',
  'Loading team members…': '正在加载团队成员…',
  'Could not load team members. Only team owners and admins can assign hosts.':
    '无法加载团队成员。只有团队所有者和管理员可以分配主持人。',
  'Required hosts': '必选主持人',
  'Unnamed team member': '未命名的团队成员',
  'Some selected hosts are not on the loaded member pages. Load the next page to find them; a host who has left the team must be replaced before saving a host change.':
    '部分选中的主持人不在已加载的成员页面中。请加载下一页查找；保存主持人变更前，必须替换已离开团队的主持人。',
  'Load more members': '加载更多成员',
  'Choose exactly one required host.': '请选择一位必选主持人。',
  'Choose two to eight required hosts.': '请选择两至八位必选主持人。',
  'Choose each host once.': '每位主持人只能选择一次。',
  'Each required host uses their current default schedule. Times are offered only when every host offers the same start and end.':
    '每位必选主持人使用各自当前的默认时间安排。只有所有主持人都可在同一时间开始和结束时，才会提供该时段。',
  'Choose two to eight required hosts to get a collective booking link.':
    '选择两至八位必选主持人后即可获取集体会议预约链接。',
  'every {0} (the duration)': '每{0}（会议时长）',
  'Create a unique Zoom meeting for each booking': '为每次预约创建独立的 Zoom 会议',
  'Choose your own authorized meetings account. Final invitations wait for the link. A Google calendar is optional.':
    '请选择自己已授权会议权限的账号。链接生成后才会发送最终邀请，无需连接 Google 日历。',
  'Zoom meetings account': 'Zoom 会议账号',
  'Choose your own authorized Zoom meetings account.': '请选择自己已授权会议权限的 Zoom 账号。',
  'Choose an account': '选择账号',
  'Saved account — unavailable for a new selection': '已保存的账号，目前无法重新选择',
  'No active Zoom meetings account is available. Authorize meeting permissions in Conference accounts first.':
    '没有可用的已启用 Zoom 会议账号。请先在会议账号页面授予会议权限。',
  'This invitation is no longer valid because the person who sent it has left the team. Ask the team for a new invitation.':
    '此邀请已失效，因为发送邀请的人已不再是团队成员。请联系团队获取新邀请。',
  'Accept invitation': '接受邀请',
  'Checking invitation…': '正在检查邀请…',
  'This invitation is unavailable. Ask a team owner or admin to open Settings → Team members, check Pending invitations, and resend it. If it expired, select Expired and send a new invitation.':
    '此邀请不可用。请团队所有者或管理员打开“设置 → 团队成员”，检查待接受的邀请并重新发送。如果邀请已过期，请选择“已过期”并发送新邀请。',
  'Use the exact email address that received this invitation. Change accounts if you signed in with another address.':
    '请使用收到此邀请的完整邮箱地址。如果你使用了其他邮箱登录，请切换账号。',
  'Confirm your email address by signing in with an email link, then return to this invitation.':
    '请通过邮件链接登录以验证邮箱，然后返回此邀请页面。',
  'This team cannot accept more members. Contact the team owner.':
    '此团队无法再添加成员。请联系团队所有者。',
  'Invitation to join {team}': '加入{team}的邀请',
  'Accepting this invitation joins the team. Signing in alone does not join it.':
    '接受此邀请后，你将加入团队。仅登录不会加入。',
  'Accepting…': '正在接受…',
  'You joined {team}.': '你已加入{team}。',
  'Change account': '切换账号',
  'Changing account…': '正在切换账号…',
  'Check invitation status': '检查邀请状态',
  'Could not confirm acceptance. Check the invitation status before trying again.':
    '无法确认是否已接受。请先检查邀请状态，再决定是否重试。',
  'Switch space': '切换空间',
  Spaces: '空间',
  Personal: '个人空间',
  'Current space': '当前空间',
  'Switching space…': '正在切换空间…',
  'Checking role…': '正在检查角色…',
  'Role unavailable': '角色暂不可用',
  'Loading spaces…': '正在加载空间…',
  'Could not load teams. Please try again.': '无法加载团队，请重试。',
  'Could not switch spaces. You are still in {space}. Please try again.':
    '无法切换空间。你仍位于{space}。请重试。',
  'Could not confirm the switch. Checking your current space…':
    '无法确认切换结果。正在检查你当前所在的空间…',
  'You are now in your personal space. Your team access or active space changed.':
    '你现在位于个人空间。你的团队访问权限或当前空间已更改。',
  'Leave team': '退出团队',
  'You left the team. Reload to open your personal space.':
    '你已退出团队。请重新加载以进入个人空间。',
  'Review leaving this team': '查看退出团队的影响',
  'Remove member': '移除成员',
  'Remove member: {0}': '移除成员：{0}',
  'Remove team member': '移除团队成员',
  'Loading departure impact…': '正在加载成员离队影响…',
  'Leave this team': '确认退出团队',
  'Leaving team…': '正在退出团队…',
  'Removing member…': '正在移除成员…',
  'Member removed. Access was revoked immediately.': '成员已移除，团队访问权限已立即撤销。',
  'Access is revoked immediately after confirmation.':
    '确认移除后，将立即撤销该成员的团队访问权限。',
  'Future bookings are kept and still need handling.': '未来预约会保留，仍需另行处理。',
  '{0} affected event types': '{0}个受影响的活动类型',
  '{0} future or in-progress bookings': '{0}个未来或进行中的预约',
  'No affected event types or bookings.': '没有受影响的活动类型或预约。',
  'Ask a team owner or admin to replace or remove you as a host.':
    '请团队所有者或管理员更换主持人，或将你从主持人名单中移除。',
  'Replace or remove yourself as a host before leaving.':
    '退出团队前，请更换主持人或将你自己从主持人名单中移除。',
  'Replace or remove this member as a host where needed.':
    '请根据需要更换主持人或将此成员从主持人名单中移除。',
  'Only team owners and admins can change team event types.':
    '只有团队所有者和管理员可以修改团队活动类型。',
  'You are the sole host for this event type.': '你是此活动类型的唯一主持人。',
  'This member is the sole host for this event type.': '此成员是此活动类型的唯一主持人。',
  'You are in the round-robin host pool.': '你在轮询主持人池中。',
  'This member is in the round-robin host pool.': '此成员在轮询主持人池中。',
  'You are a required host for this collective event type.': '你是此集体活动类型的必选主持人。',
  'This member is a required host for this collective event type.':
    '此成员是此集体活动类型的必选主持人。',
  '{0} other current verified team hosts remain.': '另有{0}位已验证的当前团队主持人。',
  'Disabled event types still need their host assignments repaired before you can leave.':
    '已停用的活动类型也需要调整主持人配置，之后你才能退出团队。',
  'Manage event type': '管理活动类型',
  'Review team bookings': '查看团队预约',
  'Coordinate cancellation with the hosts and attendees.': '请与主持人及参与者协调取消预约。',
  'Wait until the meeting ends or coordinate offline.': '请等待会议结束，或在线下协调处理。',
  'You can cancel your own hosted bookings before they start. Ask a team owner or admin for help with other team bookings.':
    '你可以在会议开始前取消自己主持的预约。其他团队预约可请团队所有者或管理员协助处理。',
  'Review your hosted booking': '查看你主持的预约',
  'More event types': '更多活动类型',
  'More bookings': '更多预约',
  'You cannot leave while team events or bookings still need handling.':
    '团队活动或预约仍有待处理事项，暂时无法退出团队。',
  'The team must retain at least one owner. Ownership transfer is not available here.':
    '团队必须保留至少一位所有者。此处暂不支持转移所有权。',
  'Your permission or this member’s team membership changed. Reload to check before trying again.':
    '你的权限或此成员的团队成员关系已变更。请重新加载并核实后再试。',
  'Your permission or team membership changed. Reload to check before trying again.':
    '你的权限或团队成员关系已变更。请重新加载并核实后再试。',
  'Reload team': '重新加载团队',
  'Loading handling list…': '正在加载处理清单…',
  'Could not load the handling list. The member is still removed.':
    '无法加载处理清单。成员已移除，移除结果不受影响。',
  'Retry handling list': '重新加载处理清单',
  '{0} event types deactivated.': '已停用{0}个活动类型。',
  'Handling list': '处理清单',
  'Affected event types': '受影响的活动类型',
  'Deactivated event types': '已停用的活动类型',
  'Repair the host assignments, then review and reactivate these event types when ready.':
    '请调整主持人配置，检查确认后再重新启用这些活动类型。',
  'Individual and collective event types are deactivated. Round-robin event types are deactivated when no other current verified team host remains.':
    '单人及集体活动类型会被停用；轮询活动类型仅在没有其他已验证的当前团队主持人时停用。',
  'Bookings needing handling': '待处理预约',
  'Saved event checks': '保存后的配置检查',
  'Save your changes to check the updated event type.': '保存更改后，即可检查更新后的活动类型。',
  'These checks describe your saved event type. Available times are confirmed when someone books.':
    '这些检查对应你已保存的活动类型。实际可约时间将在预约时确认。',
  'Readiness checks are unavailable for this account.': '此账号无法使用就绪检查。',
  'Review enablement': '查看启用设置',
  'Review meeting settings': '查看会议设置',
  'Review round-robin activation': '查看轮询激活设置',
  'Save your changes before sharing this address.': '分享此地址前，请先保存你的更改。',
  'This booking link uses the saved version. Unsaved changes are not included.':
    '此预约链接对应已保存的版本，不包含未保存的更改。',
  'This event type is inactive. Enable it and save before sharing.':
    '此活动类型尚未启用。分享前，请先启用并保存。',
  'This event type is unlisted. Anyone with its direct link can still book it. Review visibility before sharing.':
    '此活动类型已从预约页隐藏，但知道直接链接的人仍可预约。分享前，请先检查可见性设置。',
  'Review visibility': '查看可见性设置',
  'This round-robin event type is saved, but it is not activated. Activate it separately before sharing.':
    '此轮询活动类型已保存，但尚未激活。分享前，请先单独激活。',
  'Set a handle in Settings before sharing this event type.':
    '分享此活动类型前，请先在设置中填写你的用户名。',
  'Host availability needs attention before you share this event type.':
    '分享此活动类型前，请先检查主持人的可预约时间设置。',
  'This event type has no public booking link in the current space.':
    '此活动类型在当前空间中没有公开预约链接。',
  'Review saved event checks': '查看保存后的配置检查',
  'Lowercase letters, digits and hyphens. You can change this link.':
    '使用小写字母、数字和连字符。你可以修改此链接。',
  'You have no working hours yet. Use the setup guide to add a default schedule.':
    '你尚未设置工作时间。请通过设置引导添加默认日程。',
  'Set working hours with the setup guide': '通过设置引导添加工作时间',
  'Pick open times': '挑选可约时间',
  'Copy open times into an email': '将可约时间复制到邮件',
  'Choose 1–10 available times for the saved event type. Unsaved changes are not included.':
    '为已保存的活动类型选择 1 至 10 个可约时间。未保存的更改不会包含在内。',
  'Availability is checked again when you copy. Times are not reserved and may become unavailable. Invitees must confirm their bookings on the booking page.':
    '复制时会重新检查所选时间是否可约。这些时间不会被预留，受邀人打开链接时可能已不可约。受邀人仍需在预约页面上确认预约。',
  'This event type is unlisted. Anyone with these links can open the booking page and book an available time.':
    '此活动类型未公开列出。任何获得这些链接的人都可以打开预约页面，并选择可约时间进行预约。',
  'Email display': '邮件显示',
  'Meeting length': '会议时长',
  'Email language': '邮件语言',
  'Display time zone': '显示时区',
  'The language and time zone selected here apply only to the email snippet. Booking pages use each invitee’s preferences.':
    '此处选择的语言和时区仅用于邮件片段。预约页面会使用每位受邀人的偏好设置。',
  'Available times': '可选时间',
  'Loading available times…': '正在加载可约时间……',
  'We could not load available times. Please try again.': '无法加载可约时间。请重试。',
  'No times are offered on this date.': '此日期没有可约时间。',
  'Check availability again': '重新检查可约时间',
  'Selected times: {0} (maximum 10)': '已选择{0}个备选时间，最多可选 10 个',
  'Selected times': '已选时间',
  'No longer offered': '已不可约',
  'Remove {time}': '移除{time}',
  'Remove time': '移除时间',
  'Preview email': '预览邮件',
  'The email preview could not be created. Please choose fewer times and try again.':
    '无法创建邮件预览。请少选几个时间后重试。',
  'Complete plain-text email preview': '完整的纯文本邮件预览',
  'Copy plain text': '复制纯文本',
  'Copy rich text': '复制富文本',
  'The full plain text above includes every booking link.': '上方的完整纯文本包含每一个预约链接。',
  'Checking selected times…': '正在检查已选时间……',
  'This meeting length is no longer offered. Reload the saved event type before trying again.':
    '此会议时长已不可选。请重新加载已保存的活动类型后重试。',
  'We could not check the selected times. Nothing was copied. Please try again.':
    '无法检查已选时间，未复制任何内容。请重试。',
  'Some selected times are no longer offered. Nothing was copied. Remove those times manually before trying again.':
    '部分已选时间已不可约，未复制任何内容。请手动移除这些时间后重试。',
  'Plain text copied.': '已复制纯文本。',
  'Rich text copied with a plain-text fallback.': '已复制富文本，并包含纯文本备用版本。',
  'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.':
    '无法访问剪贴板。请手动选中并复制完整的纯文本预览。',
  '{0} min': '{0}分钟',
  'Checking that you can preview these times…': '正在确认你是否可以预览这些时间……',
  'We could not prepare the preview. Nothing was copied. Please try again.':
    '无法准备预览，未复制任何内容。请重试。',
  'Availability date ({zone})': '可约日期（{zone}）',
  'Email preview ready.': '邮件预览已就绪。',
  'This time could not be displayed. Please try another display time zone.':
    '无法显示此时间。请尝试其他显示时区。',
  'The saved event title is invalid. Reload the saved event type and try again.':
    '已保存的活动标题无效。请重新加载已保存的活动类型后重试。',
  'The saved booking link is invalid. Reload the saved event type and try again.':
    '已保存的预约链接无效。请重新加载已保存的活动类型后重试。',
  'The email preview could not be created. Reload the saved event type and try again.':
    '无法创建邮件预览。请重新加载已保存的活动类型后重试。',

  // Availability troubleshooting
  'Troubleshoot availability': '排查可预约时间',
  'Pick an event type and a day to see which times can be booked, and why the others cannot.':
    '选择活动类型和日期，查看哪些时间可以预约，以及其余时间为什么无法预约。',
  'There are no event types in this space to check.': '此空间中暂无可检查的活动类型。',
  'Enter a valid date.': '请输入有效的日期。',
  'Check this day': '检查这一天',
  'Checking this day…': '正在检查这一天…',
  'Could not check this day.': '无法检查这一天。',
  'You cannot troubleshoot this event type with your current access. Only its owner, or a team owner or admin, can see why times are unavailable.':
    '以你当前的权限无法排查此活动类型。只有其所有者，或团队所有者、管理员，才能查看时间无法预约的原因。',
  'Connected calendars could not be read just now, so this day cannot be explained yet. Try again shortly.':
    '暂时无法读取已连接的日历，因此还无法说明这一天的情况。请稍后重试。',
  'The default location of this event type cannot be offered right now, so no times can be checked.':
    '此活动类型的默认地点目前无法提供，因此无法检查任何时间。',
  'This day has too many possible start times to check at once.':
    '这一天可能的开始时间过多，无法一次检查。',
  'This day could not be checked. Check the date and time zone.':
    '无法检查这一天。请核对日期和时区。',
  '{available} of {total} possible times can be booked. Times are shown in {zone}.':
    '{total}个可能的时间中有{available}个可以预约。时间按{zone}显示。',
  'Hide times that are only outside the available hours':
    '隐藏仅因不在可预约时段内而无法预约的时间',
  '{count} times outside the available hours are hidden.':
    '已隐藏{count}个不在可预约时段内的时间。',
  'There are no possible start times on this day.': '这一天没有可能的开始时间。',
  'Times on this day': '这一天的时间',
  Bookable: '可预约',
  'Not bookable': '不可预约',
  '{name}:': '{name}：',
  'A team host:': '一位团队主持人：',
  '(affects {range})': '（影响{range}）',
  'This time has already passed.': '这个时间已经过去。',
  'This meeting length is not offered for this event type.': '此活动类型不提供这个会议时长。',
  'Outside the available hours (weekly hours or a date override).':
    '不在可预约时段内（每周时间段或特定日期安排）。',
  'Inside the available hours, but not one of the offered start times.':
    '在可预约时段内，但不是提供的开始时间之一。',
  'Too soon: the minimum notice before a booking has not been met.':
    '太早：未达到最短提前预约时间。',
  'Too far ahead: beyond how far in advance people can book.': '太远：超出了可提前预约的范围。',
  'A connected calendar shows this time as busy.': '已连接的日历显示这个时间忙碌。',
  'The buffer before the meeting overlaps another commitment.': '会前缓冲与其他安排重叠。',
  'The buffer after the meeting overlaps another commitment.': '会后缓冲与其他安排重叠。',
  'The daily booking limit for this event type has been reached.': '此活动类型已达到每日预约上限。',
  'The weekly booking limit for this event type has been reached.':
    '此活动类型已达到每周预约上限。',
  'The monthly booking limit for this event type has been reached.':
    '此活动类型已达到每月预约上限。',
  'Another booking already takes this time.': '这个时间已有其他预约。',
  'Not every required host is free.': '并非所有必需的主持人都有空。',
  'No host in the rotation is free.': '轮询中的主持人都没有空。',
  'Team event types are not listed: only team owners and admins can see why their times are unavailable.':
    '未列出团队活动类型：只有团队所有者和管理员才能查看这些时间无法预约的原因。',
  'Another scheduling rule applies.': '受其他排期规则限制。',
} as const
