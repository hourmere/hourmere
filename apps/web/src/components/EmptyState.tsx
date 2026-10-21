import type { ReactNode } from 'react'

/** Empty lists explain the next step, using the same panel on every admin page. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  )
}
