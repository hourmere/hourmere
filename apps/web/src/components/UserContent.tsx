import { Fragment, type ReactNode } from 'react'
import { useI18n } from '../i18n/runtime.tsx'
import { renderUiText } from '../i18n/text.tsx'
import { type MessageKey, translateParts, type UiMessage } from '../i18n/translate.ts'

/** Keep translated punctuation and spacing outside each user-provided slot. */
export function UserContentMessage({
  message,
  values,
  otherValues,
  renderValues,
}: {
  message: MessageKey
  values: Readonly<Record<string, string>>
  otherValues?: UiMessage['values']
  renderValues?: Readonly<Record<string, ReactNode>>
}) {
  const { locale, formatLocale } = useI18n()
  return translateParts(
    locale,
    message,
    { ...otherValues, ...values },
    { dateLocale: formatLocale },
  ).map((part, index) => {
    const content =
      typeof part === 'string'
        ? renderUiText(locale, part)
        : Object.hasOwn(values, part.name)
          ? (renderValues?.[part.name] ?? <bdi>{part.text}</bdi>)
          : renderUiText(locale, part.text)
    // biome-ignore lint/suspicious/noArrayIndexKey: positions identify the fragments of a translated template
    return <Fragment key={index}>{content}</Fragment>
  })
}

export function UserContentList({
  values,
  formatLocale,
  renderValue = (value) => <bdi>{value}</bdi>,
}: {
  values: readonly string[]
  formatLocale?: string | undefined
  renderValue?: (value: string, index: number) => ReactNode
}) {
  const { locale } = useI18n()
  const formatter = new Intl.ListFormat(formatLocale ?? locale, {
    type: 'conjunction',
    style: 'narrow',
  })
  let item = 0
  return formatter.formatToParts(values).map(({ type, value }, index) => {
    if (type !== 'element') return value
    // ListFormat retains the separators for an empty value but omits its element part.
    while (values[item] === '') item++
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: list values are display text and can repeat
      <Fragment key={index}>{renderValue(value, item++)}</Fragment>
    )
  })
}

/** Preserve line separators for the caller's existing whitespace and clipping styles. */
export function UserContentLines({ text }: { text: string }) {
  return text.split(/(\r\n|\r|\n|\u2028|\u2029)/u).map((line, index) =>
    index % 2 === 1 || !line ? (
      line
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: line positions identify immutable text
      <bdi key={index}>{line}</bdi>
    ),
  )
}
