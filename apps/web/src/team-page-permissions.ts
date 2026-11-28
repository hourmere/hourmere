import { type Me, useMe } from './session.tsx'

export const routingFormPermissions = {
  archive: 'routing_forms.archive',
  create: 'routing_forms.create',
  preview: 'routing_forms.preview',
  publish: 'routing_forms.publish',
  read: 'routing_forms.read',
  update: 'routing_forms.update',
} as const

export function teamPageAllows(me: Me, operation: string, fixedAllowed: boolean): boolean {
  return me.teamManagementPermissions?.includes(operation) ?? fixedAllowed
}

export function useTeamPagePermissions() {
  const me = useMe()
  if (!me.teamManagementPermissions) return { status: 'fixed' } as const
  return {
    status: 'ready',
    allows: (operation: string) => teamPageAllows(me, operation, false),
  } as const
}
