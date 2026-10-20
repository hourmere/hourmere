import { Fragment } from 'react'

/** Prefer address/path separators over breaking a word, retaining the exact copied text. */
export function BreakableText({ children }: { children: string }) {
  const parts = children.split(/(?<=[@./])/u)
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered fragments of one immutable string
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  )
}
