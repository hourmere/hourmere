import { useI18n } from '../../i18n/runtime.tsx'
import { permissionLabels, phaseOnePermissions } from './permissions.ts'

export function PermissionList({
  ids,
  empty = 'None',
}: {
  ids: readonly string[]
  empty?: 'None' | 'Your fixed team role applies.'
}) {
  const { t } = useI18n()
  const permissions = phaseOnePermissions(ids)
  return permissions.length === 0 ? (
    <p>{t(empty)}</p>
  ) : (
    <ul>
      {permissions.map((id) => (
        <li key={id}>{t(permissionLabels[id])}</li>
      ))}
    </ul>
  )
}
