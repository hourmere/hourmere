// TEMPORARY diagnostic for the embedded success-redirect flake. Removed before merge.
import { type Frame, type Page, test } from '@playwright/test'

type Entry = (string | number | boolean | null)[]

function install(isTop: boolean) {
  const w = window as unknown as { __probe?: Entry[] }
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 10) / 10
  const label = (target: EventTarget | null) => {
    if (target === document) return '#document'
    if (!(target instanceof Element)) return String(target)
    const classes =
      typeof target.className === 'string' && target.className.trim()
        ? `.${target.className.trim().split(/\s+/).join('.')}`
        : ''
    const text =
      target.tagName === 'BUTTON' ? `[${(target.textContent ?? '').trim().slice(0, 10)}]` : ''
    return `${target.tagName.toLowerCase()}${classes}${text}`
  }
  if (w.__probe) w.__probe.length = 0
  else {
    const log: Entry[] = []
    w.__probe = log
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      window.addEventListener(
        type,
        (event) => {
          const e = event as MouseEvent
          log.push([type, now(), Math.round(e.clientX), Math.round(e.clientY), label(e.target)])
        },
        true,
      )
    for (const type of ['scroll', 'scrollend'])
      window.addEventListener(
        type,
        (event) => {
          log.push([type, now(), Math.round(window.scrollY), label(event.target)])
        },
        { capture: true, passive: true },
      )
    if (isTop)
      window.addEventListener('message', (event) => {
        const data = event.data as { type?: unknown; height?: unknown } | null
        if (data && typeof data === 'object' && data.type === 'hourmere:resize')
          log.push(['resize', now(), Number(data.height)])
      })
  }
  const log = w.__probe as Entry[]
  const until = performance.now() + 3000
  const sample = () => {
    if (isTop) {
      const rect = document.querySelector('[data-hourmere-inline] iframe')?.getBoundingClientRect()
      log.push([
        'frame',
        now(),
        Math.round(window.scrollY),
        rect ? Math.round(rect.top) : null,
        rect ? Math.round(rect.height) : null,
      ])
    } else {
      const heading = document.querySelector('.slots-day')?.getBoundingClientRect()
      log.push([
        'frame',
        now(),
        Math.round(window.scrollY),
        window.innerHeight,
        document.documentElement.scrollHeight,
        heading ? Math.round(heading.top) : null,
      ])
    }
    if (performance.now() < until) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}

function embedFrame(page: Page): Frame | undefined {
  return page
    .frames()
    .find((frame) => frame !== page.mainFrame() && frame.url().includes('/embed/'))
}

export async function startProbe(page: Page) {
  const embed = embedFrame(page)
  await page.mainFrame().evaluate(install, true)
  if (embed) await embed.evaluate(install, false)
  return {
    async finish(formShown: boolean) {
      const top = (await page
        .mainFrame()
        .evaluate(() => (window as unknown as { __probe: Entry[] }).__probe)) as Entry[]
      const inner = embed
        ? ((await embed.evaluate(
            () => (window as unknown as { __probe: Entry[] }).__probe,
          )) as Entry[])
        : []
      const content = embed ? inner : top
      const pointer = content.filter((entry) =>
        ['pointerdown', 'pointerup', 'mouseup', 'click'].includes(String(entry[0])),
      )
      const dayDown = pointer.find(
        (entry) => entry[0] === 'pointerdown' && String(entry[4]).includes('day'),
      )
      const t0 = Number(dayDown?.[1] ?? content[0]?.[1] ?? 0)
      const rel = (entry: Entry) => [entry[0], Math.round(Number(entry[1]) - t0), ...entry.slice(2)]
      const slotDowns = pointer.filter(
        (entry) => entry[0] === 'pointerdown' && Number(entry[1]) > t0 && entry !== dayDown,
      )
      const at = (log: Entry[], time: number) =>
        [...log].reverse().find((entry) => entry[0] === 'frame' && Number(entry[1]) <= time)
      const attempts = slotDowns.map((down) => {
        const downT = Number(down[1])
        const up = pointer.find((entry) => entry[0] === 'pointerup' && Number(entry[1]) >= downT)
        const click = pointer.find((entry) => entry[0] === 'click' && Number(entry[1]) >= downT)
        const upT = Number(up?.[1] ?? downT)
        const moved = (log: Entry[]) =>
          log.filter(
            (entry) =>
              (entry[0] === 'scroll' || entry[0] === 'frame') &&
              Number(entry[1]) > downT &&
              Number(entry[1]) <= upT,
          ).length
        return {
          down: rel(down),
          up: up ? rel(up) : null,
          click: click ? rel(click) : null,
          parentBeforeDown:
            top
              .filter((entry) => entry[0] === 'frame' && Number(entry[1]) <= downT)
              .at(-2)
              ?.slice(2) ?? null,
          parentAtDown: at(top, downT)?.slice(2) ?? null,
          parentAtUp: at(top, upT)?.slice(2) ?? null,
          innerAtDown: embed ? (at(inner, downT)?.slice(2) ?? null) : null,
          innerAtUp: embed ? (at(inner, upT)?.slice(2) ?? null) : null,
          framesBetween: moved(top),
        }
      })
      const scrolls = (log: Entry[]) =>
        log
          .filter((entry) => entry[0] === 'scroll' || entry[0] === 'scrollend')
          .map(rel)
          .filter((entry) => Number(entry[1]) >= -50)
      const parentScrolls = scrolls(top)
      const innerScrolls = scrolls(inner)
      const resizes = top.filter((entry) => entry[0] === 'resize').map(rel)
      const topPointer = top
        .filter((entry) => ['pointerdown', 'pointerup', 'click'].includes(String(entry[0])))
        .map(rel)
      const info = test.info()
      const summary = {
        test: `${info.project.name} ${info.title} #${info.repeatEachIndex}`,
        embedded: Boolean(embed),
        formShown,
        attempts,
        parentScroll: parentScrolls.length
          ? {
              first: parentScrolls[0],
              last: parentScrolls[parentScrolls.length - 1],
              count: parentScrolls.length,
            }
          : null,
        innerScroll: innerScrolls.length
          ? {
              first: innerScrolls[0],
              last: innerScrolls[innerScrolls.length - 1],
              count: innerScrolls.length,
            }
          : null,
        resizes,
        topPointer,
      }
      console.log(`PROBE ${JSON.stringify(summary)}`)
      if (!formShown) {
        const window = (log: Entry[]) =>
          log.map(rel).filter((entry) => Number(entry[1]) >= -50 && Number(entry[1]) <= 1500)
        console.log(`PROBE-TOP ${JSON.stringify(window(top))}`)
        console.log(`PROBE-INNER ${JSON.stringify(window(inner))}`)
      }
    },
  }
}
