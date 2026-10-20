import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { newOption, newQuestion } from '../pages/event-types/event-type-form.ts'
import { QuestionsEditor } from '../pages/event-types/QuestionsEditor.tsx'
import { BookingForm } from '../public/BookingForm.tsx'
import { admin } from './admin.ts'
import { common } from './common.ts'
import { formatList } from './formatting.ts'
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
    ).toBe('你与 主持人（王小明）的“会议”预约已确认。')
    expect(
      translate('zh-CN', '{event} with {host}', { event: '会议', host: '主持人（王小明）' }),
    ).toBe('与 主持人（王小明）的会议')
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
    ['zh-CN', '问题 3 的选项', '选项 1，所属问题 3', '移除选项 1，“Pro”，所属问题 3'],
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
      expect(within(options).getByRole('button', { name: remove })).toBeDefined()
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
