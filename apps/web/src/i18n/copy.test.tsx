import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { newOption, newQuestion } from '../pages/event-types/event-type-form.ts'
import { QuestionsEditor } from '../pages/event-types/QuestionsEditor.tsx'
import { BookingForm } from '../public/BookingForm.tsx'
import { admin } from './admin.ts'
import { common } from './common.ts'
import { formatList, spaceCjkBoundaries } from './formatting.ts'
import { chooseLanguage } from './store.ts'
import { registerCatalog, translate } from './translate.ts'

registerCatalog(admin)

describe('Chinese copy and punctuation', () => {
  it('uses resource names, personal names and last-use wording in their own contexts', () => {
    expect(translate('zh-CN', 'Name')).toBe('名称')
    expect(translate('zh-CN', 'Name and time zone')).toBe('名称和时区')
    expect(translate('zh-CN', 'a name')).toBe('名称')
    expect(translate('zh-CN', 'Your name')).toBe('你的姓名')
    expect(translate('zh-CN', 'Guest {0} name', { '0': 1 })).toBe('来宾 1 的姓名')
    expect(
      translate('zh-CN', 'Enter a name on one line, up to {0} characters.', { '0': 200 }),
    ).toBe('请输入单行姓名，最多 200 个字符。')
    expect(translate('zh-CN', 'Never used')).toBe('从未使用')
    expect(translate('zh-CN', 'Never')).toBe('永不到期')
    expect(translate('zh-CN', 'No answer')).toBe('未回答')
  })

  it('keeps punctuation and its spacing inside translated messages', () => {
    expect(translate('zh-CN', 'Time zone: {zone}', { zone: 'Europe/Vienna' })).toBe(
      '时区：Europe/Vienna',
    )
    expect(translate('zh-CN', ' ({time} there)', { time: '09:00–09:30' })).toBe(
      '（09:00–09:30，当地时间）',
    )
    expect(
      translate('zh-CN', 'Your {event} with {host} is confirmed.', {
        event: '会议',
        host: '主持人（王小明）',
      }),
    ).toBe('你与主持人（王小明）的“会议”预约已确认。')
    expect(
      translate('zh-CN', '{event} with {host}', { event: '会议', host: '主持人（王小明）' }),
    ).toBe('与主持人（王小明）的会议')
    expect(translate('zh-CN', 'Required hosts: {hosts}', { hosts: '王小明、李小红' })).toBe(
      '必选主持人：王小明、李小红',
    )
    expect(
      translate('zh-CN', '{name} ({detail})', { name: '王小明', detail: 'host@example.invalid' }),
    ).toBe('王小明（host@example.invalid）')
    expect(translate('zh-CN', ' ({detail})', { detail: '工作时间' })).toBe('（工作时间）')
    expect(
      translate('zh-CN', ' ({zone}, {offset})', { zone: 'Europe/Vienna', offset: 'GMT+01:00' }),
    ).toBe('（Europe/Vienna，GMT+01:00）')
    expect(translate('zh-CN', ': ')).toBe('：')
    expect(translate('en', ': ')).toBe(': ')
    for (const [key, value] of Object.entries({ ...common, ...admin })) {
      expect(value, key).not.toMatch(/[ \t]+[，。；：！？（）]/)
      expect(value, key).not.toMatch(/[：][ \t]+/)
    }
  })

  it.each([
    { name: 'Ada Lovelace', event: 'Intro call', expected: '与 Ada Lovelace 的 Intro call' },
    { name: '王小明', event: '初次通话', expected: '与王小明的初次通话' },
    { name: '王小明', event: 'Ada’s review', expected: '与王小明的 Ada’s review' },
    { name: 'Grace Hopper', event: 'Ada’s review', expected: '与 Grace Hopper 的 Ada’s review' },
    { name: 'O’Brien', event: '初次通话', expected: '与 O’Brien 的初次通话' },
    { name: 'Zoë', event: 'Échange', expected: '与 Zoë 的 Échange' },
    { name: 'André', event: 'Intro call', expected: '与 André 的 Intro call' },
    { name: 'Ada李', event: '初次Intro交流', expected: '与 Ada李的初次Intro交流' },
    { name: '李Ada', event: 'Intro初次交流', expected: '与李Ada 的 Intro初次交流' },
    { name: '3M', event: '初次通话', expected: '与 3M 的初次通话' },
    { name: 'Δημήτρης', event: '初次交流', expected: '与Δημήτρης的初次交流' },
  ])('spaces only Han/Latin boundaries for $name and $event', ({ name, event, expected }) => {
    expect(translate('zh-CN', '{event} with {host}', { event, host: name })).toBe(expected)
    expect(translate('en', '{event} with {host}', { event, host: name })).toBe(
      `${event} with ${name}`,
    )
  })

  it('spaces inserted text only where a Latin or numeric edge meets Han prose', () => {
    expect(spaceCjkBoundaries('与', 'Ada', '的')).toBe(' Ada ')
    expect(spaceCjkBoundaries('与', '王小明', '的')).toBe('王小明')
    expect(spaceCjkBoundaries('“', 'Ada', '”')).toBe('Ada')
    expect(spaceCjkBoundaries('', 'Ada', '')).toBe('Ada')
    expect(spaceCjkBoundaries('与 ', 'Ada', ' 的')).toBe('Ada')
  })

  it('leaves quoted, punctuated and already spaced insertions alone', () => {
    expect(
      translate('zh-CN', 'Your {event} with {host} is confirmed.', {
        event: 'Ada’s review',
        host: 'O’Brien',
      }),
    ).toBe('你与 O’Brien 的“Ada’s review”预约已确认。')
    expect(translate('zh-CN', 'Edit “{0}”', { '0': 'Intro' })).toBe('编辑“Intro”')
    expect(translate('zh-CN', '{name} ({detail})', { name: 'Ada', detail: 'UTC' })).toBe(
      'Ada（UTC）',
    )
    expect(translate('zh-CN', 'Powered by {0}', { '0': 'Hourmere' })).toBe('由 Hourmere 提供支持')
    expect(translate('zh-CN', 'Guest {0} name', { '0': 2 })).toBe('来宾 2 的姓名')
  })

  it.each([
    ['王小明', 'Ada’s review', '正在为与王小明的“Ada’s review”预约改期，当前时间：10月20日，09:00'],
    [
      'Grace Hopper',
      '初次通话',
      '正在为与 Grace Hopper 的“初次通话”预约改期，当前时间：10月20日，09:00',
    ],
    [
      '王小明和Grace Hopper',
      'Ada’s review',
      '正在为与王小明和Grace Hopper 的“Ada’s review”预约改期，当前时间：10月20日，09:00',
    ],
  ])('spaces the reschedule heading around host %s', (hosts, title, expected) => {
    const values = { hosts, title, date: '10月20日', time: '09:00' }
    expect(
      translate('zh-CN', 'Rescheduling {title} with {hosts}, now on {date}, {time}', values),
    ).toBe(expected)
  })

  it.each([
    ['Ada’s review', '正在改期 Ada’s review，当前时间：10月20日，09:00'],
    ['初次通话', '正在改期初次通话，当前时间：10月20日，09:00'],
  ])('spaces the hostless reschedule heading around %s', (title, expected) => {
    expect(
      translate('zh-CN', 'Rescheduling {title}, now on {date}, {time}', {
        title,
        date: '10月20日',
        time: '09:00',
      }),
    ).toBe(expected)
  })

  it.each([
    ['09:00–12:00', '11:00–14:00', '09:00–12:00 与 11:00–14:00'],
    ['上午', '下午', '上午与下午'],
    ['Morning', '下午', 'Morning 与下午'],
  ])('joins the overlapping pair %s and %s without fixed spaces', (first, second, expected) => {
    expect(translate('zh-CN', '{first} and {second}', { first, second })).toBe(expected)
    expect(translate('en', '{first} and {second}', { first, second })).toBe(
      `${first} and ${second}`,
    )
  })

  it.each([
    ['Edit {0}', '初次通话', '编辑初次通话'],
    ['Edit {0}', 'Intro call', '编辑 Intro call'],
    ['Copy link for {0}', '初次通话', '复制初次通话的链接'],
    ['Copy link for {0}', 'Intro call', '复制 Intro call 的链接'],
    ['Revoke {0}', 'CI', '撤销 CI'],
    ['Revoke {0}', '持续集成', '撤销持续集成'],
  ] as const)('spaces %s only around Latin values', (key, value, expected) => {
    expect(translate('zh-CN', key, { '0': value })).toBe(expected)
  })

  it('composes the cancel summary as a sentence rather than a list', () => {
    const values = { title: 'Intro call', date: '2026年11月2日星期一', time: '09:00–09:30' }
    expect(translate('zh-CN', '{title}, {date}, {time}', values)).toBe(
      'Intro call，2026年11月2日星期一，09:00–09:30',
    )
    expect(translate('en', '{title}, {date}, {time}', values)).toBe(
      'Intro call, 2026年11月2日星期一, 09:00–09:30',
    )
  })

  it.each([
    ['zh-CN', '王小明、李小红、周小刚'],
    ['en', '王小明, 李小红, 周小刚'],
  ])('uses %s list punctuation for literal names and selected answers', (locale, expected) => {
    expect(formatList(['王小明', '李小红', '周小刚'], locale)).toBe(expected)
    expect(formatList([], locale)).toBe('')
    expect(formatList(['Settings'], locale)).toBe('Settings')
  })

  it.each([
    [
      'en',
      'Options for question 3',
      'Option 1 of question 3',
      'Remove option 1, “Pro”, of question 3',
    ],
    ['zh-CN', '问题 3 的选项', '问题 3 的选项 1', '移除问题 3 的选项 1“Pro”'],
  ] as const)(
    'formats whole option group and screen-reader labels in %s',
    (locale, group, option, remove) => {
      chooseLanguage(locale)
      const questions = [
        newQuestion(),
        newQuestion(),
        { ...newQuestion(), type: 'select' as const, options: [newOption('Pro')] },
      ]
      render(<QuestionsEditor questions={questions} onChange={vi.fn()} errors={{}} />)
      const options = screen.getByRole('group', { name: group })
      expect(within(options).getByLabelText(option)).toBeDefined()
      expect(within(options).queryByRole('button', { name: remove })).not.toBeNull()
    },
  )

  it.each([
    ['en', 'Topic (optional)', 'Guests (optional, up to 10)'],
    ['zh-CN', 'Topic（可选）', '来宾（可选，最多 10 位）'],
  ] as const)(
    'keeps optional suffix spacing and brackets correct in %s',
    (locale, label, guests) => {
      chooseLanguage(locale)
      render(
        <BookingForm
          allowGuests
          questions={[{ id: 'topic', label: 'Topic', type: 'short_text', required: false }]}
          values={{ name: '', email: '', guests: [], answers: {} }}
          onChange={vi.fn()}
          serverErrors={{}}
          formError={null}
          submitting={false}
          onSubmit={vi.fn()}
        />,
      )
      expect(screen.getByLabelText(label)).toBeDefined()
      expect(screen.getByRole('group').querySelector('legend')?.textContent).toBe(guests)
    },
  )
})
