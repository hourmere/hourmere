import { fileURLToPath } from 'node:url'
import sharp, { type OverlayOptions } from 'sharp'

/** Only the public booking page fields that may appear in the rendered image. */
export interface OgImageInputs {
  title: string
  durationMinutes: number
  name: string
  primaryColor?: string
}

export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

const FONT_FAMILY = 'Noto Sans CJK SC,Noto Sans Arabic,Noto Sans Hebrew,Noto Emoji'
const FONT_FILES = [
  ['Noto Sans CJK SC', 'NotoSansCJK.otf'],
  ['Noto Sans Arabic', 'NotoSansArabic.ttf'],
  ['Noto Sans Hebrew', 'NotoSansHebrew.ttf'],
  ['Noto Emoji', 'NotoEmoji.ttf'],
] as const
const DEFAULT_ACCENT = '#1F4FD8'
const TEXT_LEFT = 114
const TEXT_WIDTH = 972
const NATIVE_TIMEOUT = { seconds: 1 }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

let fontRegistration: Promise<void> | undefined

function registerFonts() {
  fontRegistration ??= (async () => {
    // The slim container has no system Fontconfig files. An operator may provide
    // their own configuration to extend the fallback coverage.
    process.env.FONTCONFIG_FILE ??= fileURLToPath(new URL('./og-fonts/fonts.conf', import.meta.url))
    if (process.platform === 'darwin') process.env.PANGOCAIRO_BACKEND ??= 'fontconfig'
    // libvips registers fontfiles on its Pango font map. Load the full fallback stack
    // before resolving any event text, even when the first request uses only Latin.
    for (const [family, filename] of FONT_FILES) {
      await sharp({
        text: {
          text: 'A',
          font: `${family} 12px`,
          fontfile: fileURLToPath(new URL(`./og-fonts/${filename}`, import.meta.url)),
        },
      })
        .timeout(NATIVE_TIMEOUT)
        .raw()
        .toBuffer()
    }
  })().catch((error: unknown) => {
    fontRegistration = undefined
    throw error
  })
  return fontRegistration
}

function template(accent: string, generic: boolean) {
  // The only dynamic SVG value is a validated six-digit hex color. Event text never
  // enters SVG, and rendering cannot fetch an external image or font.
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}">
  <defs>
    <linearGradient id="back" x2="1" y2="1">
      <stop stop-color="#0C1938"/>
      <stop offset="1" stop-color="${accent}"/>
    </linearGradient>
    <clipPath id="mark-wave"><circle cx="50" cy="50" r="21"/></clipPath>
  </defs>
  <path fill="url(#back)" d="M0 0h1200v630H0z"/>
  <g fill="none" stroke="#FFF" stroke-width="2" opacity=".32">
    <circle cx="1154" cy="580" r="112"/>
    <circle cx="1154" cy="580" r="148"/>
    <circle cx="1154" cy="580" r="184"/>
  </g>
  <rect x="54" y="54" width="1092" height="522" rx="36" fill="#FBFCFF"/>
  ${
    generic
      ? `<g transform="translate(106 108) scale(.78)">
        <rect width="100" height="100" rx="22" fill="#1F4FD8"/>
        <circle cx="50" cy="50" r="28" fill="none" stroke="#FFF" stroke-width="10"/>
        <path fill="#FFF" clip-path="url(#mark-wave)" d="M18 60C30 53 40 53 50 60S70 67 82 60v30H18Z"/>
        <path d="M50 47V33" stroke="#FFF" stroke-width="6" stroke-linecap="round"/>
        <path d="m50 47 12-7" stroke="#F2A33A" stroke-width="6" stroke-linecap="round"/>
      </g>`
      : `<rect x="114" y="112" width="52" height="6" rx="3" fill="${accent}"/>
        <path d="M114 462h972" stroke="#DEE6F4" stroke-width="2"/>
        <circle cx="128" cy="510" r="12" fill="none" stroke="#405472" stroke-width="2.5"/>
        <path d="M128 503v7l4 3" stroke="#405472" stroke-width="2.5" stroke-linecap="round" fill="none"/>`
  }
</svg>`)
}

function escapePango(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function rasterize(text: string, fontSize: number, color: string, wrap: boolean) {
  return sharp({
    text: {
      text: `<span foreground="${color}">${escapePango(text)}</span>`,
      font: `${FONT_FAMILY} Medium ${fontSize}px`,
      width: TEXT_WIDTH,
      wrap: wrap ? 'word-char' : 'none',
      rgba: true,
    },
  })
    .timeout(NATIVE_TIMEOUT)
    .raw()
    .toBuffer({ resolveWithObject: true })
}

async function fitText(
  input: string,
  {
    fontSize,
    color,
    wrap,
    maxHeight,
  }: { fontSize: number; color: string; wrap: boolean; maxHeight: number },
) {
  // Cap the work before normalizing or shaping saved names. Segment an extra code
  // point and discard the final cluster at the cut, where it might be incomplete.
  const inputLimit = 1024
  const capped = input.length > inputLimit
  const normalized = input
    .slice(0, inputLimit + 1)
    .toWellFormed()
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, '')
    .trim()
  const clusters = Array.from(segmenter.segment(normalized), ({ segment }) => segment)
  if (capped) clusters.pop()
  const clusterLimit = wrap ? 160 : 80
  const parts = clusters.slice(0, clusterLimit).map((cluster) =>
    // A single user-supplied cluster can contain hundreds of stacking marks.
    cluster.length <= 32 ? cluster : '…',
  )
  const text = parts.join('')
  // Whitespace, joiners and detached combining marks can have no drawable ink.
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(text)) return undefined

  const fits = ({ info }: Awaited<ReturnType<typeof rasterize>>) =>
    info.width <= TEXT_WIDTH && info.height <= maxHeight
  if (!capped && parts.length === clusters.length) {
    const full = await rasterize(text, fontSize, color, wrap)
    if (fits(full)) return full
  }
  // Ask Pango for real shaped pixel bounds. Binary search caps work, and every
  // candidate ends at a grapheme boundary before the ellipsis.
  let low = 0
  let high = parts.length
  let best = await rasterize('…', fontSize, color, wrap)
  while (low < high) {
    const count = Math.ceil((low + high) / 2)
    const candidate = await rasterize(
      `${parts.slice(0, count).join('').trimEnd()}…`,
      fontSize,
      color,
      wrap,
    )
    if (fits(candidate)) {
      low = count
      best = candidate
    } else high = count - 1
  }
  return best
}

export async function renderOgImage(inputs: OgImageInputs | undefined): Promise<Buffer> {
  await registerFonts()
  const accent =
    inputs?.primaryColor && /^#[0-9a-f]{6}$/i.test(inputs.primaryColor)
      ? inputs.primaryColor
      : DEFAULT_ACCENT
  const overlays: OverlayOptions[] = []
  const place = (raster: Awaited<ReturnType<typeof fitText>>, left: number, top: number) => {
    if (raster)
      overlays.push({
        input: raster.data,
        raw: { width: raster.info.width, height: raster.info.height, channels: 4 },
        left,
        top,
      })
  }
  const title = await fitText(inputs?.title ?? 'Hourmere', {
    fontSize: 70,
    color: '#152342',
    wrap: true,
    maxHeight: 222,
  })
  place(title, TEXT_LEFT, 218 + Math.floor((222 - (title?.info.height ?? 0)) / 2))
  if (inputs) {
    const name = await fitText(inputs.name, {
      fontSize: 31,
      color: '#405472',
      wrap: false,
      maxHeight: 62,
    })
    place(name, TEXT_LEFT, 147)
    const duration = await rasterize(`${inputs.durationMinutes} min`, 29, '#405472', false)
    place(duration, 152, 510 - Math.floor(duration.info.height / 2))
  }
  return sharp(template(accent, inputs === undefined), {
    limitInputPixels: OG_IMAGE_WIDTH * OG_IMAGE_HEIGHT,
  })
    .composite(overlays)
    .timeout(NATIVE_TIMEOUT)
    .png()
    .toBuffer()
}
