import {
  acceptCredentialLifecycle,
  acceptRateLimits,
  scimCredentialLiterals,
} from './scim-credential-lifecycle.ts'
import { test, withScimScenario } from './scim-fixture.ts'
import { acceptGroupProtections, acceptGroups, scimGroupLiterals } from './scim-groups-lifecycle.ts'
import { acceptMappingRecovery, acceptReadmission, scimRecoveryLiterals } from './scim-recovery.ts'
import { acceptUserPutAndDelete, acceptUsers, scimUserLiterals } from './scim-users-lifecycle.ts'

test('provisions, renames, deactivates and reactivates a Keycloak User', async ({ keycloak }) => {
  await withScimScenario(keycloak, scimUserLiterals, async (scenario) => {
    await scenario.configureTarget()
    await acceptUsers(scenario)
  })
})

test('replaces and retires Users while protecting owner and admin roles', async ({ keycloak }) => {
  await withScimScenario(keycloak, scimUserLiterals, async (scenario) => {
    await scenario.configureTarget({ userUpdateMode: 'PUT', deprovision: 'DELETE' })
    await acceptUserPutAndDelete(scenario)
  })
})

test('provisions, edits and retires a Keycloak Group and its managed roster', async ({
  keycloak,
}) => {
  await withScimScenario(keycloak, scimGroupLiterals, acceptGroups)
})

test('refuses removal of child team owner and admin access', async ({ keycloak }) => {
  await withScimScenario(keycloak, scimGroupLiterals, acceptGroupProtections)
})

test('rotates and revokes the Keycloak SCIM credential', async ({ keycloak }) => {
  await withScimScenario(keycloak, scimCredentialLiterals, acceptCredentialLifecycle)
})

test('limits SCIM traffic by source address and authenticated organization', async ({
  keycloak,
}) => {
  await withScimScenario(keycloak, [], acceptRateLimits)
})

test('readmits a retired User through the original account', async ({ keycloak }) => {
  await withScimScenario(keycloak, scimRecoveryLiterals, acceptReadmission)
})

test('suspends and detaches the directory mapping through offline recovery', async ({
  keycloak,
}) => {
  await withScimScenario(keycloak, scimRecoveryLiterals, acceptMappingRecovery)
})
