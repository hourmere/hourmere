// One searchable IANA picker for public slot selection and editable admin fields.
import { Fragment, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isKnownTimeZone } from '../format.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { type DateKey, parseDateKey } from '../public/calendar.ts'
import { availableTimeZones, detectTimeZone } from '../public/env.ts'
import { currentZoneId, instantOf, offsetLabel, zoneName } from '../public/time.ts'
import type { ControlProps } from './forms.tsx'

interface TimeZonePickerProps {
  value: string
  onChange: (value: string) => void
  /** With a field control, allow free typing so the surrounding form can validate it. */
  control?: ControlProps
  /** Offsets on this calendar date, at local noon in each listed zone. */
  referenceDate?: DateKey
  /** Fallback offset instant when no calendar date is supplied. */
  now?: number
  error?: UiText | undefined
}

const MAX_SHOWN = 100
const COMMON_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
]
const normalize = (text: string) => text.toLowerCase().replaceAll('_', ' ')

// Search aliases supplement IANA identifiers; the selected value remains the IANA ID.
const CHINESE_CITY_NAMES: Readonly<Record<string, string>> = {
  'Africa/Accra': '阿克拉',
  'Africa/Addis_Ababa': '亚的斯亚贝巴 亞的斯亞貝巴',
  'Africa/Algiers': '阿尔及尔 阿爾及爾',
  'Africa/Cairo': '开罗 開羅',
  'Africa/Casablanca': '卡萨布兰卡 卡薩布蘭卡',
  'Africa/Johannesburg': '约翰内斯堡 約翰內斯堡',
  'Africa/Lagos': '拉各斯',
  'Africa/Nairobi': '内罗毕 內羅畢',
  'Africa/Tunis': '突尼斯',
  'America/Anchorage': '安克雷奇',
  'America/Argentina/Buenos_Aires': '布宜诺斯艾利斯 布宜諾斯艾利斯',
  'America/Bogota': '波哥大',
  'America/Buenos_Aires': '布宜诺斯艾利斯 布宜諾斯艾利斯',
  'America/Caracas': '加拉加斯',
  'America/Chicago': '芝加哥',
  'America/Denver': '丹佛',
  'America/Lima': '利马 利馬',
  'America/Los_Angeles': '洛杉矶 洛杉磯',
  'America/Mexico_City': '墨西哥城',
  'America/New_York': '纽约 紐約',
  'America/Phoenix': '凤凰城 鳳凰城',
  'America/Santiago': '圣地亚哥 聖地亞哥',
  'America/Sao_Paulo': '圣保罗 聖保羅',
  'America/Toronto': '多伦多 多倫多',
  'America/Vancouver': '温哥华 溫哥華',
  'Asia/Almaty': '阿拉木图 阿拉木圖',
  'Asia/Baghdad': '巴格达 巴格達',
  'Asia/Bangkok': '曼谷',
  'Asia/Calcutta': '加尔各答 加爾各答',
  'Asia/Colombo': '科伦坡 科倫坡',
  'Asia/Dhaka': '达卡 達卡',
  'Asia/Dubai': '迪拜 杜拜',
  'Asia/Ho_Chi_Minh': '胡志明市 胡志明 西贡 西貢',
  'Asia/Hong_Kong': '香港',
  'Asia/Jakarta': '雅加达 雅加達',
  'Asia/Jerusalem': '耶路撒冷',
  'Asia/Karachi': '卡拉奇',
  'Asia/Kathmandu': '加德满都 加德滿都',
  'Asia/Katmandu': '加德满都 加德滿都',
  'Asia/Kolkata': '加尔各答 加爾各答',
  'Asia/Kuala_Lumpur': '吉隆坡',
  'Asia/Kuwait': '科威特',
  'Asia/Macau': '澳门 澳門',
  'Asia/Manila': '马尼拉 馬尼拉',
  'Asia/Riyadh': '利雅得',
  'Asia/Seoul': '首尔 首爾',
  'Asia/Shanghai': '上海 北京',
  'Asia/Singapore': '新加坡',
  'Asia/Taipei': '台北 臺北',
  'Asia/Tashkent': '塔什干',
  'Asia/Tehran': '德黑兰 德黑蘭',
  'Asia/Tokyo': '东京 東京',
  'Asia/Urumqi': '乌鲁木齐 烏魯木齊',
  'Asia/Yangon': '仰光',
  'Australia/Adelaide': '阿德莱德 阿德萊德',
  'Australia/Brisbane': '布里斯班',
  'Australia/Darwin': '达尔文 達爾文',
  'Australia/Hobart': '霍巴特',
  'Australia/Melbourne': '墨尔本 墨爾本',
  'Australia/Perth': '珀斯',
  'Australia/Sydney': '悉尼 雪梨',
  'Europe/Amsterdam': '阿姆斯特丹',
  'Europe/Athens': '雅典',
  'Europe/Berlin': '柏林',
  'Europe/Bratislava': '布拉迪斯拉发 布拉迪斯拉發',
  'Europe/Brussels': '布鲁塞尔 布魯塞爾',
  'Europe/Bucharest': '布加勒斯特',
  'Europe/Budapest': '布达佩斯 布達佩斯',
  'Europe/Copenhagen': '哥本哈根',
  'Europe/Dublin': '都柏林',
  'Europe/Helsinki': '赫尔辛基 赫爾辛基',
  'Europe/Istanbul': '伊斯坦布尔 伊斯坦堡',
  'Europe/Kiev': '基辅 基輔',
  'Europe/Kyiv': '基辅 基輔',
  'Europe/Lisbon': '里斯本',
  'Europe/London': '伦敦 倫敦',
  'Europe/Madrid': '马德里 馬德里',
  'Europe/Moscow': '莫斯科',
  'Europe/Oslo': '奥斯陆 奧斯陸',
  'Europe/Paris': '巴黎',
  'Europe/Prague': '布拉格',
  'Europe/Riga': '里加',
  'Europe/Rome': '罗马 羅馬',
  'Europe/Sofia': '索非亚 索非亞',
  'Europe/Stockholm': '斯德哥尔摩 斯德哥爾摩',
  'Europe/Vienna': '维也纳 維也納',
  'Europe/Warsaw': '华沙 華沙',
  'Europe/Zurich': '苏黎世 蘇黎世',
  'Pacific/Auckland': '奥克兰 奧克蘭',
  'Pacific/Fiji': '斐济 斐濟',
  'Pacific/Guam': '关岛 關島',
  'Pacific/Honolulu': '檀香山 火奴鲁鲁 火奴魯魯',
}
const cityNames = (id: string) =>
  CHINESE_CITY_NAMES[id] ?? CHINESE_CITY_NAMES[currentZoneId(id)] ?? ''

interface ZoneSearch {
  haystack: string
  aliases: readonly string[]
}

function matchZones<T extends ZoneSearch>(zones: readonly T[], query: string): T[] {
  const words = normalize(query)
    .split(/[\s/]+/)
    .filter(Boolean)
  const matches = zones.filter((zone) => words.every((word) => zone.haystack.includes(word)))
  // A city beginning with the query wins over one merely containing it: 柏林 is Berlin,
  // not 都柏林 (Dublin). Keep substring search when no alias begins with the query.
  return words.reduce((matches, word) => {
    const preferred = matches.filter((zone) => zone.aliases.some((alias) => alias.startsWith(word)))
    return preferred.length ? preferred : matches
  }, matches)
}

/**
 * Break opportunities after each slash; the stylesheet's `overflow-wrap: anywhere` still
 * splits a segment that is wider than a 320px option on its own, instead of overflowing.
 */
export function TimeZoneName({
  name,
  className,
  label,
}: {
  name: string
  className?: string
  label?: string
}) {
  // Only IANA name segments stay together; translated surrounding prose can wrap normally.
  const at = label?.indexOf(name) ?? -1
  if (label !== undefined && at < 0) return <span className={className}>{label}</span>
  return (
    <span className={className}>
      {at >= 0 && label?.slice(0, at)}
      {name.split('/').map((part, index, parts) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed components of a display name
        <Fragment key={index}>
          <span className="time-zone-segment">{part}</span>
          {index < parts.length - 1 && (
            <>
              {'/'}
              <wbr />
            </>
          )}
        </Fragment>
      ))}
      {at >= 0 && label?.slice(at + name.length)}
    </span>
  )
}

export function timeZoneNames(): string[] {
  try {
    return [...new Set(availableTimeZones())].sort()
  } catch {
    return ['UTC']
  }
}

export function matchTimeZones(zones: readonly string[], query: string): string[] {
  return matchZones(
    zones.map((id) => ({
      id,
      haystack: normalize(`${id} ${cityNames(id)}`),
      aliases: cityNames(id).split(/\s+/),
    })),
    query,
  ).map((zone) => zone.id)
}

interface Zone extends ZoneSearch {
  id: string
  name: string
  offset: string
  canonical: string
}

function zoneInfo(id: string, now: number, referenceDate?: DateKey): Zone {
  const name = zoneName(id)
  const offset = offsetLabel(
    id,
    referenceDate ? instantOf(parseDateKey(referenceDate), 12, 0, id) : now,
  )
  return {
    id,
    name,
    offset,
    canonical: currentZoneId(id),
    haystack: normalize(`${name} ${id} ${offset} ${cityNames(id)}`),
    aliases: cityNames(id).split(/\s+/),
  }
}

export function TimeZonePicker({
  value,
  onChange,
  control,
  now,
  referenceDate,
  error,
}: TimeZonePickerProps) {
  const { t, ui, text: translatedText } = useI18n()

  const editable = control !== undefined
  const id = useId()
  const [mountedAt] = useState(Date.now)
  const [browserTimeZone] = useState(detectTimeZone)
  const at = now ?? mountedAt
  // Typing changes only the search; changing the displayed date refreshes every offset.
  const listed = useMemo(
    () => timeZoneNames().map((zone) => zoneInfo(zone, at, referenceDate)),
    [at, referenceDate],
  )
  const zones = useMemo(() => {
    const preferredIds = new Set(editable ? [value] : [value, browserTimeZone])
    const aliases = [...preferredIds]
      .filter((id) => !listed.some((zone) => zone.id === id) && isKnownTimeZone(id))
      .map((id) => zoneInfo(id, at, referenceDate))
    if (!aliases.length) return listed
    return [
      ...listed.filter(
        (zone) =>
          preferredIds.has(zone.id) || !aliases.some((alias) => alias.canonical === zone.canonical),
      ),
      ...aliases,
    ].sort((a, b) => a.id.localeCompare(b.id))
  }, [listed, value, browserTimeZone, editable, at, referenceDate])
  // The public picker starts with the current choice and a short set of common zones.
  // Keep the editable settings combobox alphabetical for its existing keyboard navigation.
  const common = useMemo(() => {
    if (editable) return []
    const ids = new Set([value, browserTimeZone, ...COMMON_ZONES])
    return [...ids].flatMap((id) => {
      const zone = zones.find((zone) => zone.id === id)
      return zone ? [zone] : []
    })
  }, [editable, value, browserTimeZone, zones])
  const ordered = useMemo(() => {
    const ids = new Set(common.map((zone) => zone.id))
    return [...common, ...zones.filter((zone) => !ids.has(zone.id))]
  }, [common, zones])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [active, setActive] = useState(0)
  const toggle = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const text = editable ? value : query
  const matches = !editable || filtering ? matchZones(ordered, text) : ordered
  const shown = editable && filtering ? matches.slice(0, MAX_SHOWN) : matches
  const optionId = (index: number) => `${id}-option-${index}`
  const current = zones.find((zone) => zone.id === value)

  useEffect(() => {
    if (open && !editable) search.current?.focus()
  }, [open, editable])
  useEffect(() => {
    if (open)
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  })

  function close() {
    setOpen(false)
    setQuery('')
    setFiltering(false)
    if (!editable) setTimeout(() => toggle.current?.focus(), 0)
  }
  function pick(zone: string) {
    onChange(zone)
    close()
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open && event.key === 'ArrowDown') {
        setOpen(true)
        setFiltering(false)
        setActive(
          Math.max(
            0,
            ordered.findIndex((zone) => zone.id === value),
          ),
        )
      } else if (open) {
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index) => Math.min(Math.max(index + step, 0), Math.max(shown.length - 1, 0)))
      }
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const zone = shown[active]
      if (zone) pick(zone.id)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  function renderOption(zone: Zone, index: number) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input handles keys
      <div
        key={zone.id}
        id={optionId(index)}
        role="option"
        aria-selected={editable ? index === active : zone.id === value}
        data-active={index === active}
        tabIndex={-1}
        className={editable ? 'combobox-option' : 'tz-option'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(zone.id)}
        onMouseMove={() => index !== active && setActive(index)}
      >
        <TimeZoneName name={zone.name} />
        <span className={editable ? 'muted' : 'tz-offset'}>{zone.offset}</span>
      </div>
    )
  }

  return (
    <div className={editable ? 'combobox' : 'tz-picker'}>
      {!editable && (
        <button
          type="button"
          ref={toggle}
          className="tz-toggle"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-describedby={error ? `${id}-error` : undefined}
          onClick={() => {
            if (open) close()
            else {
              setActive(
                Math.max(
                  0,
                  ordered.findIndex((zone) => zone.id === value),
                ),
              )
              setOpen(true)
            }
          }}
        >
          <span className="tz-caption">{t('Time zone')}</span>
          <span className="tz-current">
            <TimeZoneName className="tz-name" name={current?.name ?? zoneName(value)} />{' '}
            <span className="tz-offset">{current?.offset}</span>
          </span>
          <span className="tz-change">{open ? t('Close') : t('Change')}</span>
        </button>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {ui(error)}
        </p>
      )}
      {(editable || open) && (
        <div className={editable ? undefined : 'tz-panel'} id={`${id}-panel`}>
          {!editable && (
            <label htmlFor={`${id}-search`} className="visually-hidden">
              {t('Search time zones')}
            </label>
          )}
          <input
            {...control}
            id={control?.id ?? `${id}-search`}
            ref={search}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-options`}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
            placeholder={t('Search by city or offset')}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              if (editable) onChange(event.target.value)
              else setQuery(event.target.value)
              setFiltering(true)
              setOpen(true)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (!editable) return
              close()
              const exact =
                listed.find((zone) => zone.id.toLowerCase() === value.trim().toLowerCase()) ??
                zones.find((zone) => zone.id.toLowerCase() === value.trim().toLowerCase())
              if (exact && exact.id !== value) onChange(exact.id)
            }}
          />
          <div
            className={editable ? 'combobox-list' : 'tz-options'}
            id={`${id}-options`}
            role="listbox"
            aria-label={t('Time zones')}
            ref={list}
            hidden={!open || shown.length === 0}
          >
            {open &&
              (!editable && !query ? (
                <>
                  {/* biome-ignore lint/a11y/useSemanticElements: APG listbox option groups use a labelled group, not form fields */}
                  <div role="group" aria-labelledby={`${id}-common`}>
                    <div className="tz-group-label" id={`${id}-common`}>
                      {t('Current and common time zones')}
                    </div>
                    {shown.slice(0, common.length).map(renderOption)}
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: APG listbox option groups use a labelled group, not form fields */}
                  <div role="group" aria-labelledby={`${id}-all`}>
                    <div className="tz-group-label" id={`${id}-all`}>
                      {t('All time zones')}
                    </div>
                    {shown
                      .slice(common.length)
                      .map((zone, index) => renderOption(zone, index + common.length))}
                  </div>
                </>
              ) : (
                shown.map(renderOption)
              ))}
          </div>
          {!editable && (
            <p className="visually-hidden" role="status">
              {matches.length === 1
                ? t('1 time zone')
                : t('{0} time zones', { '0': matches.length })}
            </p>
          )}
          {open && shown.length === 0 && (
            <div className={editable ? 'combobox-list combobox-empty' : 'muted tz-empty'}>
              {translatedText('No time zone matches “{query}”.', { query: text })}
            </div>
          )}
          {editable && open && shown.length < matches.length && (
            <p className="hint">
              {t('Type to narrow down the')} {matches.length} {t('time zones.')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
