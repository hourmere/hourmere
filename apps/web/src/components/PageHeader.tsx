import type { ReactNode } from 'react'

/** A consistent title, optional introduction and page actions for admin pages. */
export function PageHeader({
  title,
  lede,
  children,
}: {
  title: ReactNode
  lede?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="page-intro">
      <div className="page-header">
        <h1>{title}</h1>
        {children}
      </div>
      {lede && <p className="lede">{lede}</p>}
    </header>
  )
}
