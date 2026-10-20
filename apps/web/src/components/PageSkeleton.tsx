import { useI18n } from '../i18n/runtime.tsx'

/** Static placeholders preserve the page hierarchy without announcing each shape. */
export function PageSkeleton({ label = 'Loading…' }: { label?: string }) {
  const { ui } = useI18n()
  return (
    <div className="page-skeleton" role="status" aria-label={ui(label)}>
      <span className="visually-hidden">{ui(label)}</span>
      <div className="skeleton skeleton-heading" aria-hidden="true" />
      <div className="skeleton skeleton-line" aria-hidden="true" />
      <div className="skeleton skeleton-panel" aria-hidden="true" />
    </div>
  )
}
