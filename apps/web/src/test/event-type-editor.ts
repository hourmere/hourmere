import { AppShell, EventTypeEditorPage, RequireSession, SessionLayout } from '../lazy-pages.tsx'
import { resolveLazy } from './resolve-lazy.ts'

export function resolveEventTypeEditor() {
  return resolveLazy(SessionLayout, RequireSession, AppShell, EventTypeEditorPage)
}
