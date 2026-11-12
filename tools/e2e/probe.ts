// TEMPORARY diagnostic for the popup time-click race. Removed before merge.
import { type Frame, type Locator, type Page, test } from '@playwright/test'

type Entry = (string | number | null)[]
type ClickOptions = Parameters<Locator['click']>[0]
type ClientLocator = Locator & { _frame: Frame; _selector: string }

// Top page: per-frame position of the embedded iframe and its scroll container.
function installTop() {
  const w = window as unknown as { __probe?: Entry[] }
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10
  const log: Entry[] = []
  w.__probe = log
  // The fixture parent page has both an inline embed and a popup: an open popup wins.
  const findFrame = () => {
    for (const host of document.querySelectorAll('[data-hourmere-popup-host]')) {
      const frame = host.shadowRoot?.querySelector('iframe')
      if (frame) return frame
    }
    return document.querySelector('[data-hourmere-inline] iframe')
  }
  const until = performance.now() + 3000
  const sample = () => {
    const frame = findFrame()
    const rect = frame?.getBoundingClientRect()
    const content = frame?.closest('.content')
    log.push([
      'frame',
      now(),
      rect ? Math.round(rect.top * 10) / 10 : null,
      content ? Math.round(content.scrollTop * 10) / 10 : null,
      Math.round(window.scrollY),
      rect ? Math.round(rect.height) : null,
      content ? Math.round(content.scrollHeight - content.clientHeight) : null,
    ])
    if (performance.now() < until) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}

// Embedded page: pointer events and their targets.
function installInner() {
  const w = window as unknown as { __probe?: Entry[] }
  if (w.__probe) {
    w.__probe.length = 0
    return
  }
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10
  const label = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return String(target)
    const classes =
      typeof target.className === 'string' && target.className.trim()
        ? `.${target.className.trim().split(/\s+/).join('.')}`
        : ''
    const text =
      target.tagName === 'BUTTON' ? `[${(target.textContent ?? '').trim().slice(0, 12)}]` : ''
    return `${target.tagName.toLowerCase()}${classes}${text}`
  }
  const log: Entry[] = []
  w.__probe = log
  for (const type of ['pointerdown', 'pointerup', 'click'])
    window.addEventListener(
      type,
      (event) => {
        const e = event as MouseEvent
        log.push([type, now(), Math.round(e.clientX), Math.round(e.clientY), label(e.target)])
      },
      true,
    )
}

// The frame the clicked locator enters, so the probe follows the popup rather than the inline embed.
async function enteredFrame(locator: ClientLocator) {
  const enter = locator._selector.lastIndexOf(' >> internal:control=enter-frame')
  if (enter < 0) return undefined
  const handle = await locator._frame.locator(locator._selector.slice(0, enter)).elementHandle()
  const frame = (await handle?.contentFrame()) ?? undefined
  await handle?.dispose()
  return frame
}

const active = new WeakMap<Page, { frame: Frame }>()
const timeSelector = /\.slots button( >> nth=0)?$/

async function report(page: Page, frame: Frame, shown: boolean, delay: number) {
  const read = () => (window as unknown as { __probe?: Entry[] }).__probe ?? []
  const top = await page.mainFrame().evaluate(read)
  const inner = await frame.evaluate(read)
  const dayDown = inner.find((e) => e[0] === 'pointerdown' && String(e[4]).includes('day'))
  const dayT = Number(dayDown?.[1] ?? Number.NaN)
  const down = inner.find((e) => e[0] === 'pointerdown' && e !== dayDown && Number(e[1]) >= dayT)
  const downT = Number(down?.[1] ?? Number.NaN)
  const up = inner.find((e) => e[0] === 'pointerup' && Number(e[1]) >= downT)
  const upT = Number(up?.[1] ?? downT)
  const click = inner.find((e) => e[0] === 'click' && Number(e[1]) >= downT)
  const samples = top.filter((e) => e[0] === 'frame' && e[2] !== null)
  const at = (t: number) => [...samples].reverse().find((e) => Number(e[1]) <= t)
  const moves = samples.filter((e, i) => i > 0 && e[2] !== samples[i - 1]?.[2])
  const rest = samples.at(-1)
  const atDown = at(downT)
  const atUp = at(upT)
  const rel = (e: Entry | undefined) => (e ? Math.round(Number(e[1]) - dayT) : null)
  const info = test.info()
  const summary = {
    test: `${info.project.name} ${info.title} #${info.repeatEachIndex}`,
    delay,
    shown,
    pressAfterDay: rel(down),
    releaseAfterDay: rel(up),
    down: down?.[4] ?? null,
    up: up?.[4] ?? null,
    click: click?.[4] ?? null,
    topAtDown: atDown?.[2] ?? null,
    topAtUp: atUp?.[2] ?? null,
    topRest: rest?.[2] ?? null,
    scrollAtDown: atDown?.[3] ?? null,
    scrollRest: rest?.[3] ?? null,
    frameHeightRest: rest?.[5] ?? null,
    contentScrollableRest: rest?.[6] ?? null,
    movedDuringPress: Boolean(atDown && atUp && atDown[2] !== atUp[2]),
    // Moving at the press: the iframe moved within the frame before the press or before release.
    movingAtPress: moves.some((e) => Number(e[1]) > downT - 17 && Number(e[1]) <= upT),
    lastMoveBeforePress: rel(moves.filter((e) => Number(e[1]) <= downT).at(-1)),
    firstMoveAfterRelease: rel(moves.find((e) => Number(e[1]) > upT)),
    moves: moves.map((e) => [rel(e), e[2], e[3], e[5]]),
  }
  console.log(`PROBE ${JSON.stringify(summary)}`)
  if (!shown) {
    const window = (log: Entry[]) =>
      log
        .map((e) => [e[0], Math.round(Number(e[1]) - dayT), ...e.slice(2)])
        .filter((e) => Number(e[1]) >= -50 && Number(e[1]) <= 1500)
    console.log(`PROBE-TOP ${JSON.stringify(window(top))}`)
    console.log(`PROBE-INNER ${JSON.stringify(window(inner))}`)
  }
}

// Wraps Locator.click once per worker: a day click inside an embed starts the probe, and the
// next time click is pressed for HOURMERE_E2E_PICK_DELAY ms, then must open the details form.
export function installProbe(page: Page) {
  if (!process.env.HOURMERE_E2E_PROBE) return
  const proto = Object.getPrototypeOf(page.locator('body')) as {
    click: (this: ClientLocator, options?: ClickOptions) => Promise<void>
    __probe?: true
  }
  if (proto.__probe) return
  proto.__probe = true
  const original = proto.click
  proto.click = async function (this: ClientLocator, options?: ClickOptions) {
    const selector = this._selector
    const owner = this.page()
    if (selector.includes('button.day-available')) {
      const frame = await enteredFrame(this)
      if (frame) {
        await owner.mainFrame().evaluate(installTop)
        await frame.evaluate(installInner)
        active.set(owner, { frame })
      }
      return original.call(this, options)
    }
    const probe = active.get(owner)
    if (!probe || !timeSelector.test(selector)) return original.call(this, options)
    active.delete(owner)
    const delay = Number(process.env.HOURMERE_E2E_PICK_DELAY ?? 0)
    await original.call(this, delay ? { ...options, delay } : options)
    const shown = await this._frame
      .locator(selector.replace(timeSelector, '#details-heading'))
      .waitFor({ timeout: 3000 })
      .then(
        () => true,
        () => false,
      )
    await report(owner, probe.frame, shown, delay)
    if (!shown) throw new Error('PROBE: the time click did not open the details form')
  }
}
