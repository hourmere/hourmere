import type { ReactNode, Ref } from 'react'

/** A consistent title, optional introduction and page actions for admin pages. */
export function PageHeader({
  title,
  headingRef,
  lede,
  children,
}: {
  title: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
  lede?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="page-intro">
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
          {title}
        </h1>
        {children}
      </div>
      {lede && <p className="lede">{lede}</p>}
    </header>
  )
}
