import { expect, fillInvitee, pickSlot, test } from '../fixtures.ts'

for (const selected of ['en', 'zh-CN'] as const) {
  const zh = selected === 'zh-CN'
  test(`round-robin owner saves, explicitly activates and books actual hosts with stable management (${selected})`, async ({
    page,
    app,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('hourmere-language', value), selected)
    await app.authorizeHost('owner')
    await page.goto(`${app.url}/app/event-types/new`)
    await page.getByLabel(zh ? '标题' : 'Title', { exact: true }).fill('Rotating introduction')
    await page
      .getByLabel(zh ? '排期方式' : 'Scheduling', { exact: true })
      .selectOption('round_robin')
    await page.getByLabel('Second Required Host', { exact: true }).check()
    await page
      .getByRole('button', { name: zh ? '创建活动类型' : 'Create event type', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: zh ? '轮询激活' : 'Round-robin activation', exact: true }),
    ).toBeVisible()
    await expect(page.getByText(zh ? '待激活' : 'Needs activation', { exact: true })).toBeVisible()
    const path = '/team/FixtureTeam/rotating-introduction'
    expect(
      (
        await page.request.get(`${app.url}/api/v1/public/teams/FixtureTeam/rotating-introduction`)
      ).status(),
    ).toBe(404)
    await page
      .getByRole('button', { name: zh ? '激活轮询' : 'Activate round robin', exact: true })
      .click()
    await expect(
      page.getByText(zh ? '轮询已激活。' : 'Round robin activated.', { exact: true }),
    ).toBeVisible()
    await page.goto(`${app.url}${path}`)
    await expect(
      page.getByText(
        zh
          ? '预约时将为你分配一位可用的团队成员。'
          : 'An available team member will be assigned when you book.',
        { exact: true },
      ),
    ).toBeVisible()
    await pickSlot(page, page)
    await fillInvitee(page)
    await page
      .getByRole('button', { name: zh ? '确认预约' : 'Confirm booking', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: zh ? '预约成功' : 'You’re booked', exact: true }),
    ).toBeVisible()
    const first = await app.roundRobinState('rotating-introduction')
    expect(first.sequence).toBe('1')
    expect(first.assignedNames).toHaveLength(1)
    await expect(page.getByText(`${first.assignedNames[0]} (UTC)`, { exact: true })).toBeVisible()
    const manage = await page
      .getByLabel(
        zh ? '用于更改或取消此预约的链接' : 'Your link to change or cancel this booking',
        { exact: true },
      )
      .inputValue()
    await page.goto(`${app.url}${path}`)
    await pickSlot(page, page)
    await fillInvitee(page)
    await page
      .getByRole('button', { name: zh ? '确认预约' : 'Confirm booking', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: zh ? '预约成功' : 'You’re booked', exact: true }),
    ).toBeVisible()
    const second = await app.roundRobinState('rotating-introduction')
    expect(second.sequence).toBe('2')
    expect(new Set(second.assignedNames).size).toBe(2)
    await page.goto(manage)
    await page.getByRole('button', { name: zh ? '改期' : 'Reschedule', exact: true }).click()
    await pickSlot(page, page)
    await page
      .getByRole('button', { name: zh ? '确认新时间' : 'Confirm new time', exact: true })
      .click()
    await expect(
      page.getByText(zh ? '你的预约已改至新时间。' : 'Your booking is moved to the new time.', {
        exact: true,
      }),
    ).toBeVisible()
    const moved = await app.roundRobinState('rotating-introduction')
    expect(moved.sequence).toBe('2')
    expect(moved.assignedNames.at(-1)).toBe(first.assignedNames[0])
    await page
      .getByRole('button', { name: zh ? '取消预约' : 'Cancel booking', exact: true })
      .click()
    await expect(
      page.getByRole('heading', {
        name: zh ? '取消此预约？' : 'Cancel this booking?',
        exact: true,
      }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: zh ? '取消预约' : 'Cancel booking', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: zh ? '已取消的预约' : 'Cancelled booking', exact: true }),
    ).toBeVisible()
    expect((await app.roundRobinState('rotating-introduction')).sequence).toBe('2')
    expect((await app.hostCounts()).every((n) => n === 1)).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
  })

  test(`round-robin popup shares no host mapping or capability with its parent (${selected})`, async ({
    page,
    app,
  }) => {
    let privateReads = 0
    page.on('request', (r) => {
      if (/\/api\/v1\/(?:me|profile)$/.test(new URL(r.url()).pathname)) privateReads++
    })
    await page.goto(`${app.parentUrl}/round?language=${selected}`)
    await page.getByRole('button', { name: 'Book a meeting', exact: true }).click()
    const frame = page.getByRole('dialog').locator('iframe').contentFrame()
    await expect(
      frame.getByRole('heading', { name: 'Round-robin fixture call', exact: true }),
    ).toBeVisible()
    for (let month = 0; month < 4; month++) {
      await expect(frame.locator('.calendar-grid[aria-busy="true"]')).toHaveCount(0)
      const days = frame.locator('button.day-available')
      if (await days.count()) {
        await days.last().click()
        await frame.locator('.slots button').first().click()
        break
      }
      await frame.getByRole('button', { name: zh ? '下个月' : 'Next month', exact: true }).click()
    }
    await fillInvitee(frame)
    await frame
      .getByRole('button', { name: zh ? '确认预约' : 'Confirm booking', exact: true })
      .click()
    await expect(
      frame.getByRole('heading', { name: zh ? '预约成功' : 'You’re booked', exact: true }),
    ).toBeVisible()
    expect(await app.hostCounts()).toEqual([1])
    expect((await app.roundRobinState()).sequence).toBe('1')
    const messages = await page.evaluate(
      () => (window as unknown as { fixtureMessages: unknown[] }).fixtureMessages,
    )
    expect(messages.every((m) => !/token|@|assignedHost|Host/.test(JSON.stringify(m)))).toBe(true)
    expect(privateReads).toBe(0)
  })
}
