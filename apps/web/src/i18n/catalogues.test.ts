import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { type Catalog, catalogueCoverage } from './catalogues.ts'

const teamMessages = {
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
}

const groups = {
  common: import.meta.glob<Catalog>('./catalogues/*/common.ts', { eager: true, import: 'common' }),
  admin: import.meta.glob<Catalog>('./catalogues/*/admin.ts', { eager: true, import: 'admin' }),
  widget: import.meta.glob<Catalog>('./catalogues/*/widget.ts', { eager: true, import: 'widget' }),
}

describe('catalogue coverage and interpolation', () => {
  it('preserves team creation and role copy in the English and Chinese catalogues', () => {
    const english = groups.admin['./catalogues/en/admin.ts']
    const chinese = groups.admin['./catalogues/zh-CN/admin.ts']
    for (const [key, translation] of Object.entries(teamMessages)) {
      expect(english?.[key], key).toBe(key)
      expect(chinese?.[key], key).toBe(translation)
    }
  })

  it('preserves the reviewed Chinese sign-in request copy', () => {
    expect(groups.admin['./catalogues/zh-CN/admin.ts']).toMatchObject({
      'We received your sign-in link request for': '我们已收到此邮箱的登录链接请求：',
      '. If this address can sign in, check your inbox for a link. It works once and expires in a few minutes.':
        '。如果此邮箱可以登录，请检查收件箱中的登录链接。链接仅可使用一次，几分钟后过期。',
    })
  })

  for (const { code } of registeredLocales)
    it(`reports ${code} coverage and validates every translated placeholder`, () => {
      for (const [group, modules] of Object.entries(groups)) {
        const english = modules[`./catalogues/en/${group}.ts`] ?? {}
        expect(Object.keys(english).length).toBeGreaterThan(0)
        const translated = modules[`./catalogues/${code}/${group}.ts`] ?? {}
        const coverage = catalogueCoverage(english, translated)
        console.info(`${code}/${group}: ${coverage.translated}/${coverage.total} messages`)
        expect(coverage.malformed, `${code}/${group}: malformed placeholders`).toEqual([])
        if (code === 'en' || code === 'zh-CN') expect(coverage.missing).toEqual([])
        else if (coverage.missing.length)
          console.warn(`${code}/${group}: ${coverage.missing.length} messages fall back to English`)
      }
    })

  it('allows partial translations while rejecting missing, added and malformed placeholders', () => {
    const english = { greeting: 'Hello {name}', count: '{count} times', absent: 'English fallback' }
    expect(catalogueCoverage(english, { greeting: 'Welcome {name}' })).toEqual({
      total: 3,
      translated: 1,
      missing: ['count', 'absent'],
      malformed: [],
    })
    for (const greeting of [
      'Hello',
      'Hello {other}',
      'Hello {name} {name}',
      'Hello {name',
      'Hello {name} }',
    ])
      expect(catalogueCoverage(english, { greeting }).malformed).toEqual(['greeting'])
  })
})
