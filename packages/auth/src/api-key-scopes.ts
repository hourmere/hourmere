import type { ApiKeyScope } from './api-key-metadata.ts'
import { apiKeyOperation } from './api-key-operations.ts'

export type ApiKeyScopePrincipal =
  | { kind: 'api_key'; apiKeyScope: ApiKeyScope }
  | { kind: 'session' | 'oauth' }

export class ApiKeyScopeError extends Error {
  readonly error = 'insufficient_scope'
  readonly status = 403

  constructor() {
    super('This API key does not allow this operation.')
    this.name = 'ApiKeyScopeError'
  }
}

/** Restrict validated key authority without granting session, OAuth or resource access. */
export function apiKeyAllows(principal: ApiKeyScopePrincipal, operationId: string): boolean {
  if (principal.kind !== 'api_key') return true
  // Full preserves native authorization, including future operations and session-only denials.
  if (principal.apiKeyScope === 'full') return true
  const operation = apiKeyOperation(operationId)
  return operation?.allowedScopes.includes(principal.apiKeyScope) ?? false
}

export function requireApiKeyOperation(principal: ApiKeyScopePrincipal, operationId: string): void {
  if (!apiKeyAllows(principal, operationId)) throw new ApiKeyScopeError()
}
