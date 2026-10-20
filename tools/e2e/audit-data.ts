// Deliberately synthetic, public fixture text. No production accounts or credentials.
export const AUDIT_NOW = '2030-01-07T10:00:00.000Z'
export const AUDIT_BOOKING_START = '2030-01-09T14:00:00.000Z'
export const AUDIT_BOOKING_END = '2030-01-09T14:30:00.000Z'
export const AUDIT_TITLE = '跨地区产品设计与项目协作讨论：这是一段用于检查窄屏换行的中文活动标题'
export const AUDIT_DESCRIPTION =
  'Synthetic layout fixture. Discuss scheduling, accessibility, and responsive interfaces. ' +
  '这是一段用于测量中文长文本换行的合成活动说明。详情请见：' +
  `https://hourmere.invalid/${'unbroken-layout-measurement-'.repeat(12)}`
export const AUDIT_EMAIL = `${'long.synthetic.attendee.'.repeat(6)}@hourmere.invalid`

export interface AuditFixtureState {
  eventTypeId: string
  scheduleId: string
  bookingId: string
  manageToken: string
  bookingPath: string
}

// Mask all capability presentations, including inputs whose current value is a DOM
// property rather than an HTML attribute. Text matching also covers plain-text emails.
export const visualMaskSelector = [
  'input[readonly]',
  'textarea[readonly]',
  'input[type="email"]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[value*="hm_"]',
  'a[href*="token=" i]',
  'a[href^="mailto:"]',
  '[data-private]',
  '.manage-link',
  'code',
  'pre',
].join(',')
export const visualMaskText =
  /[^\s@]+@[^\s@]+|\bhm_[a-z\d_]+|[#?]token=|(?:https?:\/\/)?127\.0\.0\.1:\d+/i
