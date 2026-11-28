// Install the schema extension before scheduling constructs shared response schemas.
import '@hono/zod-openapi'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import {
  type Auth,
  type AuthConfig,
  assertSignupEnforced,
  type CallerResolver,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  recordSsoAdmissionRemoval,
  scimClaimAdmissionOnly,
  scimClaimCompletion,
  withScimResources,
} from '@hourmere/auth'
import {
  bookingCalendarJob,
  bookingCalendarRecoveryJob,
  bookingConferenceJob,
  type CalendarDeps,
  calendarBookingNotifier,
  calendarDispatchJob,
  calendarSyncJob,
  conferenceBookingNotifier,
  conferenceDispatchJob,
  conferenceMirrorDispatchJob,
  createGoogleCalendarClient,
  createMicrosoftCalendarClient,
} from '@hourmere/calendars'
import {
  type CalDavSyncDeps,
  calDavBookingJob,
  calDavBookingNotifier,
  calDavDispatchJob,
  calDavRecoveryJob,
  calDavSyncJob,
  createCalDavDiscovery,
  createCalDavSyncClient,
  createCalDavSyncEnqueuer,
  createCalDavWriteClient,
} from '@hourmere/calendars/caldav'
import { type ConferenceDeps, createZoomClient } from '@hourmere/conferences'
import { createZoomConferenceWork } from '@hourmere/conferences/worker'
import { createZoomMeetingsClient } from '@hourmere/conferences/zoom-meetings'
import {
  createDb,
  createPool,
  type Db,
  deleteUnreferencedRoutingVersions,
  purgeExpiredRoutingReceipts,
  ROUTING_RECEIPT_PURGE_BATCH,
  runMigrations,
} from '@hourmere/db'
import {
  auditLogRetentionJob,
  createJobs,
  oneTimeBookingLinksRetentionJob,
  paymentHoldsExpiryJob,
  routingRetentionJob,
} from '@hourmere/jobs'
import { meetingPollCapabilityExpiryJob, meetingPollCleanupJob } from '@hourmere/jobs/meeting-polls'
import { waitlistMaintenanceJobs } from '@hourmere/jobs/waitlist'
import { createLogMailer, createSmtpMailer, type Mailer } from '@hourmere/mail'
import {
  bookingNotificationJob,
  bookingNotifier,
  conferenceNotificationDispatchJob,
  createDepartureHandoffEmailQueue,
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  createMeetingPollEmailWorker,
  createWaitlistEmailWorker,
  departureHandoffCleanupJob,
  departureHandoffEmailJob,
  groupHostMailJob,
  hasPendingHandoffCancellation,
  type InvitationEmailQueue,
  invitationEmailJob,
  invitationEmailRepairJob,
  meetingPollEmailJob,
  notificationEmailCleanupJob,
  queuedSignInEmail,
  repairScheduledBookingEmails,
  rescheduleRequestExpiryJob,
  reserveInvitationEmailBudget,
  type ScheduledEmailQueue,
  scheduledBookingEmailJob,
  scheduledBookingEmailRepairJob,
  seriesNotificationDispatchJob,
  signInEmailJobs,
  waitlistEmailJob,
} from '@hourmere/notifications'
import type { PaymentProvider, ServiceContext } from '@hourmere/scheduling'
import {
  type AttendeeNoShowNotifier,
  type BookingNotifier,
  cleanupMeetingPolls,
  cleanupWaitlist,
  ensureMeetingPollKey,
  ensureWaitlistKey,
  expireMeetingPollCapabilities,
  expirePaymentHolds,
  purgeAuditEvents,
  type RecurringBookingAdmissionDeps,
  recurringBookingAdmissionEnabled,
  removeWaitlist,
  scanWaitlists,
  verifyWaitlist,
} from '@hourmere/scheduling'
import {
  cleanupDepartureHandoffProposals,
  type EnqueueDepartureHandoffEmail,
} from '@hourmere/scheduling/departure-handoff-proposals'
import type { EnqueueDepartureHandoffRun } from '@hourmere/scheduling/departure-handoff-queue'
import { departureHandoffStore } from '@hourmere/scheduling/departure-handoff-store'
import {
  captureWorkflowWebhook,
  type WebhookQueue,
  type WebhookSettings,
  webhookAttendeeNoShowNotifier,
  webhookBookingNotifier,
  webhookCleanupJob,
  webhookDeliveryJob,
} from '@hourmere/webhooks'
import {
  captureWorkflowBooking,
  executeWorkflowClaim,
  shouldRunWorkflowJobs,
  type WorkflowSettings,
  type WorkflowWakePort,
  workflowJobs,
} from '@hourmere/workflows'
import { sql } from 'kysely'
import { type AppDeps, createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import {
  DEPARTURE_HANDOFF_RUN_RECOVERY_JOB,
  departureHandoffRunJobs,
  enqueueDepartureHandoffRunJob,
} from './departure-handoff-run-jobs.ts'
import { httpServerOptions } from './http-timeouts.ts'
import { auditLogTools } from './mcp/audit-log.ts'
import { availabilityTroubleshootingTools } from './mcp/availability-troubleshooting.ts'
import { bookingTools } from './mcp/bookings.ts'
import { brandingTools } from './mcp/branding.ts'
import { catalogTools } from './mcp/catalog.ts'
import { departureHandoffParticipantTools } from './mcp/departure-handoff-participant.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { eventTypeTools } from './mcp/event-types.ts'
import { integrationTools } from './mcp/integrations.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollTools } from './mcp/meeting-polls.ts'
import { mcpOAuthCleanupJob, mcpOAuthRoutes } from './mcp/oauth.ts'
import { oneTimeLinkTools } from './mcp/one-time-links.ts'
import { openTimeSnippetTools } from './mcp/open-time-snippets.ts'
import { publicTeamTool } from './mcp/public-team.ts'
import { routingFormConfigurationTools } from './mcp/routing-forms.ts'
import { scimMappingAdministration } from './mcp/scim-team-mappings.ts'
import { slackDestinationTools } from './mcp/slack-destinations.ts'
import { ssoReadTools } from './mcp/sso.ts'
import type { Tool } from './mcp/tools.ts'
import { waitlistTools } from './mcp/waitlist.ts'
import { webhookTools } from './mcp/webhooks.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { workflowTools } from './mcp/workflows.ts'
import { nativeTeamLeave } from './native-team-leave.ts'
import { installOneLineConsole } from './one-line-console.ts'
import type { RouteModule } from './openapi.ts'
import type { OwnershipTransferDeps } from './ownership-transfer.ts'
import {
  type OwnershipTransferNoticeQueue,
  ownershipTransferNoticeJob,
} from './ownership-transfer-notices.ts'
import { paymentRefundJob } from './payment-refund-job.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { auditLogRoutes } from './routes/audit-log.ts'
import { availabilityTroubleshootingRoutes } from './routes/availability-troubleshooting.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { brandingRoutes } from './routes/branding.ts'
import { caldavRoutes } from './routes/caldav.ts'
import { calendarRoutes } from './routes/calendars.ts'
import { conferenceRoutes } from './routes/conferences.ts'
import { customRoleRoutes } from './routes/custom-roles.ts'
import { departureHandoffParticipantRoutes } from './routes/departure-handoff-participant.ts'
import { departureHandoffRunRoutes } from './routes/departure-handoff-runs.ts'
import { type DepartureHandoffs, departureHandoffRoutes } from './routes/departure-handoffs.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { instanceRoutes } from './routes/instance.ts'
import { meetingPollHostRoutes } from './routes/meeting-poll-host.ts'
import { meetingPollRoutes } from './routes/meeting-polls.ts'
import { memberDepartureImpactRoutes } from './routes/member-departure-impact.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { oneTimeBookingRoutes } from './routes/one-time-bookings.ts'
import { oneTimeLinkRoutes } from './routes/one-time-links.ts'
import { openTimeSnippetRoutes } from './routes/open-time-snippets.ts'
import { ownershipTransferRoutes } from './routes/ownership-transfer.ts'
import { profileRoutes } from './routes/profile.ts'
import { provisioningTokenRoutes } from './routes/provisioning-tokens.ts'
import { publicRoutes } from './routes/public.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { routingContinuationRoutes } from './routes/routing-continuations.ts'
import { routingFormRoutes } from './routes/routing-forms.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { slackDestinationRoutes } from './routes/slack-destinations.ts'
import { ssoRoutes } from './routes/sso.ts'
import { ssoDelegationRoutes } from './routes/sso-delegation.ts'
import { ssoDomainRoutes } from './routes/sso-domains.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { ssoIdentityRecoveryRoutes } from './routes/sso-link-recovery.ts'
import { ssoPolicyRoutes } from './routes/sso-policy.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import { teamBookingBulkPreviewRoutes } from './routes/team-booking-bulk-preview.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { workflowRoutes } from './routes/workflows.ts'
import { zoomEventRoutes } from './routes/zoom-events.ts'
import { parseRoutingFormsEnabled, resolveRoutingFormsEnabled } from './routing-form-setting.ts'
import { scimResourceHandlers } from './scim-resources.ts'
import { type ScimMappingNoticeQueue, scimMappingNoticeJob } from './scim-team-mapping-notices.ts'
import { closeConnectionsWhen, closeServer } from './shutdown.ts'
import { configuredSmsJobs, createConfiguredSmsInbound } from './sms.ts'
import { type SsoCapabilities, ssoRetained } from './sso.ts'
import { SSO_DOMAIN_RECHECK_JOB, ssoDomainRecheckJob } from './sso-domain-recheck.ts'
import { type SsoLinkRemovalQueue, ssoLinkRemovalEmailJob } from './sso-link-recovery.ts'
import {
  type MailboxProofQueue,
  mailboxProofJobs,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
import { type OidcProviderTestDeps, oidcSignInRoutes } from './sso-oidc-sign-in.ts'
import { ssoOperatorRecoveryEmailJob } from './sso-operator-recovery.ts'
import {
  type SsoRecoveryEnrollmentQueue,
  ssoRecoveryEnrollmentEmailJob,
} from './sso-recovery-enrollment.ts'
import { samlSignInRoutes } from './sso-saml-sign-in.ts'
import { createStripePaymentProvider } from './stripe-checkout.ts'
import { createStripeClient } from './stripe-client.ts'
import {
  TEAM_BOOKING_BULK_JOB,
  TEAM_BOOKING_BULK_RECOVERY_JOB,
  teamBookingBulkCancellationJobs,
} from './team-booking-bulk-jobs.ts'
import type { EnqueueBulkCancellation } from './team-booking-bulk-worker.ts'
import type { InvitationSummaryMailLimits } from './team-invitations.ts'
import { createWorkerHealthApp } from './worker-health.ts'

/**
 * The SSO capabilities of the running server follow the operator settings.
 * While off, stored SSO state stays readable, recoverable and reducible
 * (Setting-off behaviour in docs/sso.md).
 */
export function productionSsoCapabilities(
  config: Pick<Config, 'SSO_OIDC_ENABLED' | 'SSO_SAML_ENABLED' | 'SCIM_PROVISIONING_ENABLED'>,
): SsoCapabilities {
  return withScimResources(
    {
      ssoOidcEnabled: config.SSO_OIDC_ENABLED,
      ssoSamlEnabled: config.SSO_SAML_ENABLED,
      ssoOperatorSetting: true,
    },
    config.SCIM_PROVISIONING_ENABLED,
  )
}

// Production completes SCIM claims through invitation acceptance only.
const productionScimClaims = { invitation: scimClaimCompletion.invitation }
// Admission stays hard-off until participants can approve offers in production.
const productionDepartureHandoffsEnabled = false

/**
 * The /api/v1 route groups, each created with what it needs. The OpenAPI document (and with
 * it the web app's types, `npm run api:types`) is made from this same list. Route groups hold
 * only db, the notifier and in-memory rate limiters, and creating them touches none of them.
 */
export function productRoutes({
  db,
  socialProviders,
  notify,
  notifyAttendeeNoShow,
  googleCalendar,
  microsoftCalendar,
  caldavCalendar,
  zoomConference,
  zoomWebhookSecretToken,
  zoomWebhookClientId,
  enqueueCalendarSync,
  enqueueCalendarWritebackRecovery,
  mcpAuth,
  publicUrl = 'http://localhost',
  webhooks = { enabled: false },
  webhookQueue,
  automaticMeet = false,
  automaticZoom = false,
  followUpHostNotesEnabled = true,
  smsRemindersAvailable = false,
  embedAllowedOrigins,
  scimProvisioningEnabled = false,
  scimResourcesEnabled,
  slotSnippetsEnabled = false,
  teamPublicHomeOrganizationIds,
  ssoConfigurationKey,
  ssoPrivateTargets,
  ssoLinkRemovalQueue,
  ssoRecoveryEnrollmentQueue,
  ssoOidcEnabled: oidcEnabled = false,
  ssoSamlEnabled: samlEnabled = false,
  ssoOperatorSetting,
  routingFormsEnabled: routingEnabled = false,
  successRedirectAllowIpHosts = false,
  successRedirectPolicy = { publicUrl, allowIpHosts: successRedirectAllowIpHosts },
  bookingMaxInviteeReschedules,
  bookingExportMaxConcurrent,
  teamBookingBulk,
  hostedSignupUrl,
  privacyPolicyUrl,
  termsUrl,
  invitationMailLimits,
  waitlistSecret,
  meetingPollSecret,
  routingSecret,
  routingBookingReceiptNow,
  departureHandoffs,
  ownershipTransfer,
  workflowRunCursorSecret,
  workflowsEnabled,
  smtpConfigured,
  recurringBookingsEnabled,
  paidBookingAvailability,
  paymentProvider,
  paymentStatusSecret,
  auditLogRetentionDays = null,
  customRolesEnabled = false,
}: {
  db: Db
  customRolesEnabled?: boolean | undefined
  paidBookingAvailability?: ServiceContext['paidBookingAvailability']
  paymentProvider?: PaymentProvider | undefined
  paymentStatusSecret?: string | undefined
  /** AUDIT_LOG_RETENTION_DAYS: days, or null (the default) to keep events forever. */
  auditLogRetentionDays?: number | null
  automaticMeet?: boolean
  automaticZoom?: boolean
  followUpHostNotesEnabled?: boolean
  smsRemindersAvailable?: boolean
  embedAllowedOrigins?: readonly string[]
  scimProvisioningEnabled?: boolean
  scimResourcesEnabled?: boolean | undefined
  slotSnippetsEnabled?: boolean
  teamPublicHomeOrganizationIds?: readonly string[] | undefined
  /** Operator-managed key for encrypted provider configuration; does not enable SSO. */
  ssoConfigurationKey?: Buffer | undefined
  ssoPrivateTargets?: OidcProviderTestDeps['privateTargets']
  ssoLinkRemovalQueue?: SsoLinkRemovalQueue | undefined
  ssoRecoveryEnrollmentQueue?: SsoRecoveryEnrollmentQueue | undefined
  /** SSO_OIDC_ENABLED as the running server passes it; tests inject it directly. */
  ssoOidcEnabled?: boolean
  /** SSO_SAML_ENABLED as the running server passes it; tests inject it directly. */
  ssoSamlEnabled?: boolean
  /** Passed by the running server: a protocol that is off keeps its Setting-off behaviour. */
  ssoOperatorSetting?: boolean | undefined
  /** In-process test injection only; no operator setting exists during hard-off. */
  routingFormsEnabled?: boolean
  routingBookingReceiptNow?: () => Temporal.Instant
  /** Staged acceptance can inject a store and a clock. Production admission stays hard-off. */
  departureHandoffs?: DepartureHandoffs
  ownershipTransfer?: OwnershipTransferDeps | undefined
  successRedirectAllowIpHosts?: boolean
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
  bookingMaxInviteeReschedules?: number | undefined
  bookingExportMaxConcurrent?: number | undefined
  teamBookingBulk?: {
    bulkSelectionSecret: string
    enqueueBulkCancellation: EnqueueBulkCancellation
  }
  hostedSignupUrl?: string
  privacyPolicyUrl?: string
  termsUrl?: string
  invitationMailLimits: InvitationSummaryMailLimits
  waitlistSecret?: string | undefined
  meetingPollSecret?: string | undefined
  routingSecret?: string | undefined
  workflowRunCursorSecret?: string | undefined
  smtpConfigured?: boolean | undefined
  webhooks?: import('@hourmere/webhooks').WebhookSettings
  webhookQueue?: import('@hourmere/webhooks').WebhookQueue | undefined
  mcpAuth?: Pick<ReturnType<typeof createAuth>, 'handler'> | undefined
  publicUrl?: string
  socialProviders: Config['socialProviders']
  notifyAttendeeNoShow?: AttendeeNoShowNotifier | undefined
  /** Queues booking emails in the booking's transaction (the OpenAPI document needs none). */
  notify?: BookingNotifier | undefined
  googleCalendar?: CalendarDeps['google']
  microsoftCalendar?: CalendarDeps['microsoft']
  caldavCalendar?: CalendarDeps['caldav']
  zoomConference?: ConferenceDeps['zoom']
  zoomWebhookSecretToken?: string | undefined
  zoomWebhookClientId?: string | undefined
  enqueueCalendarSync?: CalendarDeps['enqueueSync']
  enqueueCalendarWritebackRecovery?: CalendarDeps['enqueueWritebackRecovery']
} & RecurringBookingAdmissionDeps &
  WorkflowSettings): RouteModule[] {
  const microsoftCalendarEnabled = microsoftCalendar !== undefined
  const ssoCapabilities = withScimResources(
    { ssoOidcEnabled: oidcEnabled, ssoSamlEnabled: samlEnabled, ssoOperatorSetting },
    scimResourcesEnabled,
  )
  return [
    mcpOAuthRoutes({
      auth: mcpAuth,
      db,
      publicUrl,
      ssoCapabilities,
      customRolesEnabled,
    }),
    instanceRoutes({
      publicUrl,
      ...(customRolesEnabled && { customRolesDb: db }),
      socialProviders,
      scimProvisioningEnabled,
      teamOwnershipTransferEnabled: ownershipTransfer !== undefined,
      automaticMeet,
      smsRemindersAvailable,
      eventTypePaymentAvailability: paidBookingAvailability,
      automaticZoom,
      followUpHostNotesEnabled,
      slotSnippetsEnabled,
      hostedSignupUrl,
      embedAllowedOrigins,
      privacyPolicyUrl,
      termsUrl,
      ssoOidcEnabled: oidcEnabled,
      ssoSamlEnabled: samlEnabled,
      routingFormsEnabled: routingEnabled,
      workflowsEnabled,
    }),
    calendarRoutes({
      db,
      google: googleCalendar,
      microsoft: microsoftCalendar,
      caldav: caldavCalendar,
      enqueueSync: enqueueCalendarSync,
      enqueueWritebackRecovery: enqueueCalendarWritebackRecovery,
    }),
    caldavRoutes({ db, caldav: caldavCalendar }),
    conferenceRoutes({ db, zoom: zoomConference }),
    zoomEventRoutes({
      db,
      secretToken: zoomWebhookSecretToken,
      clientId: zoomWebhookClientId,
    }),
    provisioningTokenRoutes({ db, enabled: scimProvisioningEnabled }),
    profileRoutes({ db }),
    scheduleRoutes({ db }),
    webhookRoutes({ db, ...webhooks, workflowsEnabled }),
    brandingRoutes({ db }),
    auditLogRoutes({ db, auditLogRetentionDays }),
    ssoRoutes({ db, capabilities: ssoCapabilities }),
    customRoleRoutes({ db, publicUrl, capabilities: ssoCapabilities, enabled: customRolesEnabled }),
    ssoPolicyRoutes({
      db,
      publicUrl,
      capabilities: ssoCapabilities,
    }),
    ssoDomainRoutes({
      db,
      publicUrl,
      capabilities: ssoCapabilities,
    }),
    ssoDraftRoutes({
      db,
      publicUrl,
      configurationKey: ssoConfigurationKey,
      privateTargets: ssoPrivateTargets,
      capabilities: ssoCapabilities,
    }),
    ssoIdentityRecoveryRoutes({
      db,
      publicUrl,
      capabilities: ssoCapabilities,
      notificationQueue: ssoLinkRemovalQueue,
    }),
    ssoRecoveryEnrollmentRoutes({
      db,
      publicUrl,
      capabilities: ssoCapabilities,
      notificationQueue: ssoRecoveryEnrollmentQueue,
    }),
    ssoDelegationRoutes({
      db,
      publicUrl,
      configurationKey: ssoConfigurationKey,
      capabilities: ssoCapabilities,
    }),
    slackDestinationRoutes({ db, ...webhooks, queue: webhookQueue }),
    eventTypeRoutes({
      db,
      followUpHostNotesEnabled,
      smsRemindersAvailable,
      paidBookingAvailability,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      successRedirectPolicy,
      recurringBookingsEnabled,
    }),
    meetingPollRoutes({ db, meetingPollSecret }),
    meetingPollHostRoutes({
      db,
      publicUrl,
      meetingPollSecret,
      notify,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      smsRemindersAvailable,
    }),
    publicRoutes({
      db,
      teamPublicHomeOrganizationIds,
      routingFormsEnabled: routingEnabled,
      routingSecret,
      receiptNow: routingBookingReceiptNow,
      smsRemindersAvailable,
      waitlistSecret,
      smtpConfigured,
      publicUrl,
      notify,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      successRedirectPolicy,
      paymentProvider,
      paymentStatusSecret,
      paidBookingsEnabled: paidBookingAvailability === 'available',
    }),
    routingContinuationRoutes({
      db,
      now: () => Temporal.Now.instant(),
      routingFormsEnabled: routingEnabled,
      routingSecret,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      smsRemindersAvailable,
    }),
    oneTimeBookingRoutes({
      db,
      smsRemindersAvailable,
      notify,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      successRedirectPolicy,
    }),
    oneTimeLinkRoutes({ db, publicUrl }),
    openTimeSnippetRoutes({
      db,
      publicUrl,
      slotSnippetsEnabled,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    routingFormRoutes({ db, routingFormsEnabled: routingEnabled }),
    availabilityTroubleshootingRoutes({
      db,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    bookingRoutes({
      db,
      routingFormsEnabled: routingEnabled,
      smsRemindersAvailable,
      notify,
      notifyAttendeeNoShow,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      bookingMaxInviteeReschedules,
      bookingExportMaxConcurrent,
    }),
    teamBookingRoutes({
      db,
      notify,
      departureHandoffEnabled: Boolean(departureHandoffs && notify),
      ...teamBookingBulk,
    }),
    departureHandoffRoutes({
      db,
      notify,
      handoffs: departureHandoffs,
      smtpConfigured,
      capabilities: ssoCapabilities,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    departureHandoffRunRoutes({ db, handoffs: departureHandoffs, capabilities: ssoCapabilities }),
    departureHandoffParticipantRoutes({
      db,
      handoffs: departureHandoffs,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    teamBookingBulkPreviewRoutes({ db, ssoCapabilities, ...teamBookingBulk }),
    teamInvitationRoutes({ db, invitationMailLimits }),
    memberDepartureImpactRoutes({ db }),
    memberRemovalRoutes({
      db,
      recordAdmissionRemoval: oidcEnabled || samlEnabled ? recordSsoAdmissionRemoval : undefined,
    }),
    memberLeaveRoutes({
      db,
      recordAdmissionRemoval: oidcEnabled || samlEnabled ? recordSsoAdmissionRemoval : undefined,
    }),
    ownershipTransferRoutes(ownershipTransfer),
    analyticsRoutes({ db }),
    readinessRoutes({
      db,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    // Recovery operations stay available when the operator pauses workflows.
    workflowRoutes({
      db,
      followUpHostNotesEnabled,
      workflowRunCursorSecret,
      workflowsEnabled,
    }),
  ]
}

/** The same tool registry is used by the running server and capability contract tests. */
export function productTools({
  db,
  departureHandoffs,
  webhooks = { enabled: false },
  webhookQueue,
  waitlistSecret,
  meetingPollSecret,
  routingSecret,
  routingBookingReceiptNow,
  smtpConfigured,
  publicUrl,
  slotSnippetsEnabled = false,
  teamPublicHomeOrganizationIds,
  // Hard-off unless the running server passes its configured capabilities.
  ssoCapabilities: sso = { ssoOidcEnabled: false, ssoSamlEnabled: false },
  routingFormsEnabled: routingEnabled = false,
  followUpHostNotesEnabled,
  workflowRunCursorSecret,
  workflowsEnabled,
  smsRemindersAvailable = false,
  paidBookingAvailability,
  successRedirectPolicy,
  notify,
  notifyAttendeeNoShow,
  automaticMeet,
  automaticZoom,
  bookingMaxInviteeReschedules,
  googleCalendar,
  microsoftCalendar,
  caldavCalendar,
  zoomConference,
  auditLogRetentionDays = null,
}: {
  db: Db
  departureHandoffs?: DepartureHandoffs | undefined
  /** AUDIT_LOG_RETENTION_DAYS: days, or null (the default) to keep events forever. */
  auditLogRetentionDays?: number | null
  webhooks?: import('@hourmere/webhooks').WebhookSettings
  webhookQueue?: import('@hourmere/webhooks').WebhookQueue | undefined
  waitlistSecret?: string | undefined
  meetingPollSecret?: string | undefined
  routingSecret?: string | undefined
  routingBookingReceiptNow?: (() => Temporal.Instant) | undefined
  smtpConfigured?: boolean | undefined
  slotSnippetsEnabled?: boolean | undefined
  teamPublicHomeOrganizationIds?: readonly string[] | undefined
  /** Hard-off unless the running server passes its configured capabilities. */
  ssoCapabilities?: SsoCapabilities | undefined
  routingFormsEnabled?: boolean | undefined
  publicUrl?: string | undefined
  smsRemindersAvailable?: boolean | undefined
  paidBookingAvailability?: ServiceContext['paidBookingAvailability']
  followUpHostNotesEnabled?: boolean | undefined
  workflowRunCursorSecret?: string | undefined
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
  notifyAttendeeNoShow?: AttendeeNoShowNotifier | undefined
  notify?: BookingNotifier | undefined
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  bookingMaxInviteeReschedules?: number | undefined
  googleCalendar?: CalendarDeps['google']
  microsoftCalendar?: CalendarDeps['microsoft']
  caldavCalendar?: CalendarDeps['caldav']
  zoomConference?: ConferenceDeps['zoom']
} & WorkflowSettings): Tool[] {
  const microsoftCalendarEnabled = microsoftCalendar !== undefined
  return [
    whoamiTool,
    publicTeamTool({
      db,
      teamPublicHomeOrganizationIds,
      scimResourcesEnabled: sso.scimResourcesEnabled,
    }),
    ...bookingTools({
      db,
      paidCheckoutAvailable: paidBookingAvailability === 'available',
      waitlistSecret,
      smtpConfigured,
      smsRemindersAvailable,
      notify,
      notifyAttendeeNoShow,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      bookingMaxInviteeReschedules,
      routingFormsEnabled: routingEnabled,
      routingSecret,
      receiptNow: routingBookingReceiptNow,
    }),
    ...catalogTools({
      db,
      followUpHostNotesEnabled,
      smsRemindersAvailable,
      paidBookingAvailability,
    }),
    ...brandingTools({ db }),
    ...auditLogTools({ db, auditLogRetentionDays }),
    ...eventTypeTools({
      db,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      smsRemindersAvailable,
      paidBookingAvailability,
      followUpHostNotesEnabled,
      successRedirectPolicy,
    }),
    ...oneTimeLinkTools({ db, publicUrl }),
    ...slackDestinationTools({ db, ...webhooks, queue: webhookQueue }),
    ...webhookTools({ db, ...webhooks, workflowsEnabled }),
    ...(slotSnippetsEnabled
      ? openTimeSnippetTools({
          db,
          publicUrl,
          slotSnippetsEnabled,
          automaticMeet,
          automaticZoom,
          microsoftCalendarEnabled,
        })
      : []),
    ...availabilityTroubleshootingTools({
      db,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
    }),
    ...integrationTools({
      calendar: { db, google: googleCalendar, caldav: caldavCalendar },
      conference: { db, zoom: zoomConference },
    }),
    ...meetingPollTools({ db, meetingPollSecret }),
    ...departureHandoffParticipantTools({
      db,
      handoffs: departureHandoffs,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      scimResourcesEnabled: sso.scimResourcesEnabled,
    }),
    ...meetingPollHostTools({
      db,
      publicUrl: publicUrl ?? 'http://localhost',
      meetingPollSecret,
      notify,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      smsRemindersAvailable,
    }),
    ...waitlistTools({ db, secret: waitlistSecret, publicUrl, smtpConfigured }),
    // Known workflow tools stay callable for recovery when hidden by operator-off.
    ...workflowTools({
      db,
      followUpHostNotesEnabled,
      workflowRunCursorSecret,
      workflowsEnabled,
    }),
    ...ssoReadTools({ db, capabilities: sso }),
    ...routingFormConfigurationTools({
      db,
      routingFormsEnabled: routingEnabled,
      routingSecret,
      publicUrl,
      automaticMeet,
      automaticZoom,
      microsoftCalendarEnabled,
      smsRemindersAvailable,
    }),
  ]
}

/** What the running server's app options need beyond the configuration. */
export interface ProductionAppDeps extends RecurringBookingAdmissionDeps {
  customRolesEnabled?: boolean | undefined
  enqueueDepartureHandoffEmail?: EnqueueDepartureHandoffEmail
  enqueueDepartureHandoffRun?: EnqueueDepartureHandoffRun
  enqueueScimInvitation: ReturnType<typeof createInvitationEmailDispatcher>
  config: Config
  db: Db
  stripeTransport?: typeof fetch | undefined
  stripeAccountVerified?: boolean | undefined
  /** Effective state after the startup namespace check. */
  routingFormsEnabled?: boolean
  /** Better Auth session reads are used by the provider-test callback. */
  auth: Pick<Auth, 'handler'> & { api?: Pick<Auth['api'], 'getSession'> }
  /** createCallerResolver for that auth. */
  resolveCaller: CallerResolver
  /** createMcpOAuthResolver for that auth; used when MCP_OAUTH_ENABLED. */
  resolveMcpOAuth: ReturnType<typeof createMcpOAuthResolver>
  checkDb: AppDeps['checkDb']
  waitlist: NonNullable<AppDeps['waitlist']>
  invitationMailLimits: InvitationSummaryMailLimits
  webhookSettings: WebhookSettings
  /** The job queue Slack test deliveries are enqueued on. */
  webhookQueue: WebhookQueue
  notify: BookingNotifier
  notifyAttendeeNoShow: AttendeeNoShowNotifier
  googleCalendar: CalendarDeps['google']
  microsoftCalendar: CalendarDeps['microsoft']
  caldavCalendar?: CalendarDeps['caldav']
  zoomConference: ConferenceDeps['zoom']
  enqueueCalendarSync: CalendarDeps['enqueueSync']
  enqueueCalendarWritebackRecovery: CalendarDeps['enqueueWritebackRecovery']
  enqueueBulkCancellation?: EnqueueBulkCancellation
  /** The job queue SSO mailbox proof emails are enqueued on. */
  mailboxProofQueue: MailboxProofQueue
  ownershipTransferNoticeQueue?: OwnershipTransferNoticeQueue | undefined
  scimMappingNotices: ScimMappingNoticeQueue
  ssoLinkRemovalQueue?: SsoLinkRemovalQueue | undefined
  ssoRecoveryEnrollmentQueue?: SsoRecoveryEnrollmentQueue | undefined
}

/**
 * The createApp options as the running server assembles them: every route group, page,
 * static asset, MCP and SCIM mount that the configuration enables. startServer serves
 * createApp(productionAppOptions(...)); tests that must see the production routes (not a
 * reduced test assembly) build the app the same way.
 */
export function productionAppOptions({
  config,
  db,
  stripeTransport,
  stripeAccountVerified = false,
  customRolesEnabled,
  routingFormsEnabled = false,
  auth,
  resolveCaller,
  resolveMcpOAuth,
  checkDb,
  waitlist,
  invitationMailLimits,
  enqueueDepartureHandoffEmail,
  enqueueDepartureHandoffRun,
  enqueueScimInvitation,
  webhookSettings,
  webhookQueue,
  notify,
  notifyAttendeeNoShow,
  googleCalendar,
  microsoftCalendar,
  caldavCalendar,
  zoomConference,
  enqueueCalendarSync,
  enqueueCalendarWritebackRecovery,
  enqueueBulkCancellation,
  mailboxProofQueue,
  ownershipTransferNoticeQueue,
  scimMappingNotices,
  ssoLinkRemovalQueue,
  ssoRecoveryEnrollmentQueue,
  recurringBookingsEnabled,
}: ProductionAppDeps): AppDeps {
  const workflowsEnabled = config.WORKFLOWS_ENABLED
  const paidBookingAvailability = !config.stripe
    ? 'stripe_not_configured'
    : !config.PAID_BOOKINGS_ENABLED
      ? 'disabled'
      : config.stripe.mode === 'live'
        ? 'live_mode_unavailable'
        : stripeAccountVerified
          ? 'available'
          : 'stripe_unverified'
  const paymentProvider =
    paidBookingAvailability === 'available' && config.stripe
      ? createStripePaymentProvider(config.stripe, config.PUBLIC_URL, stripeTransport)
      : undefined
  // All configuration transports and public booking routes share the instance policy.
  const successRedirectPolicy = {
    publicUrl: config.PUBLIC_URL,
    allowIpHosts: config.SUCCESS_REDIRECT_ALLOW_IP_HOSTS,
  }
  const ssoConfigurationKey = config.SSO_ENCRYPTION_KEY
    ? Buffer.from(config.SSO_ENCRYPTION_KEY, 'base64')
    : undefined
  const ssoPrivateTargets = config.SSO_PRIVATE_TARGETS
  const sso = productionSsoCapabilities(config)
  const ownershipTransfer =
    config.TEAM_OWNERSHIP_TRANSFER_ENABLED && ownershipTransferNoticeQueue
      ? {
          db,
          capabilities: sso,
          publicUrl: config.PUBLIC_URL,
          notificationQueue: ownershipTransferNoticeQueue,
        }
      : undefined
  const readSsoSession = async (headers: Headers) =>
    (
      await auth.api?.getSession({
        headers,
        query: { disableRefresh: true, disableCookieCache: true },
      })
    )?.session
  return {
    checkDb,
    scim: {
      db,
      enabled: config.SCIM_PROVISIONING_ENABLED,
      ...(config.SCIM_PROVISIONING_ENABLED && {
        resources: scimResourceHandlers(
          db,
          {
            signup: config.signup,
            reserve: (trx, input) => reserveInvitationEmailBudget(trx, input, invitationMailLimits),
            enqueue: enqueueScimInvitation,
          },
          scimMappingNotices,
        ),
        mappingAdministration: scimMappingAdministration({
          db,
          capabilities: sso,
          publicUrl: config.PUBLIC_URL,
          resourcesEnabled: true,
          notices: scimMappingNotices,
        }),
      }),
    },
    smsInbound: createConfiguredSmsInbound(config, db),
    stripeWebhook: { db, config: config.stripe, enabled: config.PAID_BOOKINGS_ENABLED, notify },
    authHandler: auth.handler,
    resolveCaller,
    teamPermissionsDb: db,
    publicUrl: config.PUBLIC_URL,
    embedOrigins: config.EMBED_ALLOWED_ORIGINS,
    hstsMaxAge: config.HSTS_MAX_AGE,
    trustedProxies: config.trustedProxies,
    webDist: config.WEB_DIST,
    routingFormsEnabled,
    waitlist,
    ssoTeamReads: { capabilities: sso, db },
    // Mounted in every state. Mailbox proof serves recovery and trust-reducing operations
    // while the setting is off; the protocol endpoints answer 404 sso_disabled when off.
    ssoMailboxProof: mailboxProofRoutes({
      capabilities: sso,
      ...(customRolesEnabled && { customRolesEnabled }),
      db,
      queue: mailboxProofQueue,
      ownershipTransferEnabled: ownershipTransfer !== undefined,
    }),
    ssoOidcSignIn: oidcSignInRoutes({
      capabilities: sso,
      db,
      configurationKey: ssoConfigurationKey,
      privateTargets: ssoPrivateTargets,
      signup: config.signup,
      scimClaims: config.SCIM_PROVISIONING_ENABLED ? productionScimClaims : scimClaimAdmissionOnly,
      session: { secret: config.BETTER_AUTH_SECRET },
      readSession: readSsoSession,
    }),
    ssoSamlSignIn: samlSignInRoutes({
      capabilities: sso,
      db,
      configurationKey: ssoConfigurationKey,
      signup: config.signup,
      session: { secret: config.BETTER_AUTH_SECRET },
      readSession: readSsoSession,
    }),
    // db is closed by the caller.
    routes: productRoutes({
      ...sso,
      customRolesEnabled,
      ssoConfigurationKey,
      ssoPrivateTargets,
      ssoLinkRemovalQueue,
      ssoRecoveryEnrollmentQueue,
      scimProvisioningEnabled: config.SCIM_PROVISIONING_ENABLED,
      mcpAuth: config.MCP_OAUTH_ENABLED ? auth : undefined,
      publicUrl: config.PUBLIC_URL,
      db,
      invitationMailLimits,
      ownershipTransfer,
      waitlistSecret: config.BETTER_AUTH_SECRET,
      paymentStatusSecret: config.BETTER_AUTH_SECRET,
      paidBookingAvailability,
      paymentProvider,
      meetingPollSecret: config.BETTER_AUTH_SECRET,
      smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
      socialProviders: config.socialProviders,
      automaticMeet: config.GOOGLE_MEET_ENABLED,
      automaticZoom: config.ZOOM_MEETINGS_ENABLED,
      followUpHostNotesEnabled: config.FOLLOW_UP_HOST_NOTES_ENABLED,
      smsRemindersAvailable: config.SMS_PROVIDER === 'twilio',
      recurringBookingsEnabled,
      embedAllowedOrigins: config.EMBED_ALLOWED_ORIGINS,
      slotSnippetsEnabled: config.SLOT_SNIPPETS_ENABLED,
      teamPublicHomeOrganizationIds: config.TEAM_PUBLIC_HOME_ORGANIZATION_IDS,
      successRedirectPolicy,
      bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
      bookingExportMaxConcurrent: config.BOOKING_EXPORT_MAX_CONCURRENT,
      ...(config.TEAM_BOOKING_BULK_CANCELLATION_ENABLED &&
        enqueueBulkCancellation && {
          teamBookingBulk: {
            bulkSelectionSecret: config.BETTER_AUTH_SECRET,
            enqueueBulkCancellation,
          },
        }),
      auditLogRetentionDays: config.AUDIT_LOG_RETENTION_DAYS,
      hostedSignupUrl: config.HOSTED_SIGNUP_URL,
      privacyPolicyUrl: config.PRIVACY_POLICY_URL,
      termsUrl: config.TERMS_URL,
      webhooks: webhookSettings,
      webhookQueue,
      notify,
      notifyAttendeeNoShow,
      googleCalendar,
      microsoftCalendar,
      caldavCalendar,
      zoomConference,
      zoomWebhookSecretToken: config.ZOOM_WEBHOOK_SECRET_TOKEN,
      zoomWebhookClientId: config.ZOOM_CLIENT_ID,
      enqueueCalendarSync,
      enqueueCalendarWritebackRecovery,
      routingFormsEnabled,
      routingSecret: config.BETTER_AUTH_SECRET,
      departureHandoffs: productionDepartureHandoffsEnabled
        ? {
            store: departureHandoffStore,
            hasPendingCancellation: hasPendingHandoffCancellation,
            enqueue: enqueueDepartureHandoffEmail,
            enqueueRun: enqueueDepartureHandoffRun,
          }
        : undefined,
      workflowRunCursorSecret: config.BETTER_AUTH_SECRET,
      workflowsEnabled,
    }),
    mcp: mcpEndpoint({
      ...(config.MCP_OAUTH_ENABLED
        ? {
            oauth: {
              resolve: resolveMcpOAuth,
              handler: auth.handler,
            },
          }
        : {}),
      tools: productTools({
        db,
        slotSnippetsEnabled: config.SLOT_SNIPPETS_ENABLED,
        waitlistSecret: config.BETTER_AUTH_SECRET,
        meetingPollSecret: config.BETTER_AUTH_SECRET,
        publicUrl: config.PUBLIC_URL,
        followUpHostNotesEnabled: config.FOLLOW_UP_HOST_NOTES_ENABLED,
        successRedirectPolicy,
        departureHandoffs: productionDepartureHandoffsEnabled
          ? { store: departureHandoffStore }
          : undefined,
        paidBookingAvailability,
        smsRemindersAvailable: config.SMS_PROVIDER === 'twilio',
        smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
        notify,
        notifyAttendeeNoShow,
        automaticMeet: config.GOOGLE_MEET_ENABLED,
        automaticZoom: config.ZOOM_MEETINGS_ENABLED,
        bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
        auditLogRetentionDays: config.AUDIT_LOG_RETENTION_DAYS,
        googleCalendar,
        microsoftCalendar,
        caldavCalendar,
        zoomConference,
        webhooks: webhookSettings,
        webhookQueue,
        routingFormsEnabled,
        routingSecret: config.BETTER_AUTH_SECRET,
        workflowRunCursorSecret: config.BETTER_AUTH_SECRET,
        workflowsEnabled,
        teamPublicHomeOrganizationIds: config.TEAM_PUBLIC_HOME_ORGANIZATION_IDS,
        ssoCapabilities: sso,
      }),
    }),
  }
}

/** What the running server's Better Auth options need beyond the configuration. */
export interface ProductionAuthDeps {
  config: Config
  /** createAuthPool(config.DATABASE_URL, config.signup, its connection timeout). */
  pool: AuthConfig['pool']
  db: Db
  mailer: Mailer
  invitationDelivery: Parameters<typeof createInvitationEmailDispatcher>[0]
  invitationMailLimits: InvitationSummaryMailLimits
  /** The job queue sign-in emails are enqueued on. */
  jobs: Parameters<typeof queuedSignInEmail>[0]
}

/**
 * The createAuth options as the running server assembles them: every Better Auth plugin and
 * endpoint that the configuration enables. startServer calls
 * createAuth(productionAuthOptions(...)); tests that must see the production Better Auth
 * endpoints build it the same way.
 */
export function productionAuthOptions({
  config,
  pool,
  db,
  mailer,
  invitationDelivery,
  invitationMailLimits,
  jobs,
}: ProductionAuthDeps): AuthConfig {
  const sso = productionSsoCapabilities(config)
  const recordAdmissionRemoval =
    sso.ssoOidcEnabled || sso.ssoSamlEnabled ? recordSsoAdmissionRemoval : undefined
  return {
    pool,
    db,
    leaveTeamMember: nativeTeamLeave(db, recordAdmissionRemoval),
    recordAdmissionRemoval,
    ssoCapabilities: sso,
    scimResourcesEnabled: config.SCIM_PROVISIONING_ENABLED,
    scimClaims: config.SCIM_PROVISIONING_ENABLED ? productionScimClaims : scimClaimAdmissionOnly,
    baseURL: config.PUBLIC_URL,
    secret: config.BETTER_AUTH_SECRET,
    mailer,
    enqueueInvitationEmail: createInvitationEmailDispatcher(invitationDelivery),
    reserveInvitationEmail: (trx, input) =>
      reserveInvitationEmailBudget(trx, input, invitationMailLimits),
    queueSignInEmail: queuedSignInEmail(jobs, {
      db,
      secret: config.BETTER_AUTH_SECRET,
      publicUrl: config.PUBLIC_URL,
    }),
    signup: config.signup,
    socialProviders: config.socialProviders,
    mcpOAuth: config.MCP_OAUTH_ENABLED,
  }
}

export interface RunningServer {
  port: number
  /**
   * Stops accepting requests, stops the job workers (waiting for running jobs up to a
   * timeout), closes the database pools and restores the console.
   */
  close(): Promise<void>
}

interface StartServerOptions
  extends RecurringBookingAdmissionDeps,
    Pick<AuthConfig, 'organizationListRateLimitMaxForTests'> {
  /** Custom role admission is available only to an explicit in-process acceptance setup. */
  customRolesEnabled?: boolean | undefined
  /** In-process transport injection for isolated test-mode acceptance. */
  stripeTransport?: typeof fetch | undefined
}

/** Starts Hourmere from environment variables (see .env.example) and optional test dependencies. */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  // First, before anything can log: one line per console call, control characters escaped.
  const restoreConsole = installOneLineConsole()
  try {
    return await start(env, options, restoreConsole)
  } catch (err) {
    restoreConsole()
    throw err
  }
}

async function start(
  env: NodeJS.ProcessEnv,
  options: StartServerOptions,
  restoreConsole: () => void,
): Promise<RunningServer> {
  const config = loadConfig(env)
  const sso = productionSsoCapabilities(config)
  const routingFormsRequested = parseRoutingFormsEnabled(env.ROUTING_FORMS_ENABLED)
  const workflowsEnabled = config.WORKFLOWS_ENABLED
  const role = config.HOURMERE_ROLE
  if (config.WEBHOOK_PRIVATE_TARGETS.length)
    console.warn(
      'WEBHOOK_PRIVATE_TARGETS permits operator-trusted private webhook destinations. Self-hosting only; Hourmere Cloud must never enable this setting.',
    )
  const poolOptions = { connectionTimeoutMillis: config.databaseConnectionTimeout }
  const pool = createPool(config.DATABASE_URL, poolOptions)
  const db = createDb(pool)

  if (config.AUTO_MIGRATE) {
    const applied = await runMigrations(pool)
    if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`)
  }

  let runWorkflowJobs = false
  let routingFormsEnabled = false
  try {
    // Only a web-serving role can claim /route. Skip the lookup entirely when off.
    if (role !== 'worker' && routingFormsRequested) {
      routingFormsEnabled = await resolveRoutingFormsEnabled({ db, routingFormsEnabled: true })
    }
    await db.transaction().execute((trx) => ensureWaitlistKey(trx, config.BETTER_AUTH_SECRET))
    await db.transaction().execute((trx) => ensureMeetingPollKey(trx, config.BETTER_AUTH_SECRET))
    // An explicitly paused worker still skips previously captured runs as they come due.
    // A paused install without work to recover needs no workflow jobs. Web roles never consume wakes.
    runWorkflowJobs = role !== 'web' && (await shouldRunWorkflowJobs(db, { workflowsEnabled }))
  } catch (error) {
    await db.destroy()
    throw error
  }

  let mailer: Mailer
  if (config.SMTP_URL && config.MAIL_FROM) {
    mailer = createSmtpMailer({ url: config.SMTP_URL, from: config.MAIL_FROM })
  } else {
    const bar = '!'.repeat(78)
    for (const line of [
      bar,
      '!! EMAIL IS NOT CONFIGURED: SMTP_URL is not set.',
      '!! Sign-in links are printed to this log instead of being emailed, so anyone who can',
      '!! read this log can sign in as any user. Fine for trying Hourmere on your own; set',
      '!! SMTP_URL and MAIL_FROM before anyone else uses this instance. Hosted and',
      '!! internet-facing deployments must always set them.',
      bar,
    ]) {
      console.warn(line)
    }
    mailer = createLogMailer()
  }
  // Sign-in emails go out after the request is answered, and shutdown does not wait for them;
  // the count is for saying how many it drops.
  let sending = 0
  const sender = mailer
  const countingMailer: Mailer = {
    async send(message) {
      sending += 1
      try {
        await sender.send(message)
      } finally {
        sending -= 1
      }
    },
  }

  // A worker serves only /api/health, for the container health check: no sign-in, no API.
  const authPool =
    role === 'worker' ? undefined : createAuthPool(config.DATABASE_URL, config.signup, poolOptions)
  if (authPool) {
    try {
      await assertSignupEnforced(authPool, config.signup)
    } catch (err) {
      await Promise.all([db.destroy(), authPool.end()])
      throw err
    }
  }

  const googleCalendar =
    config.GOOGLE_CALENDAR_CLIENT_ID &&
    config.GOOGLE_CALENDAR_CLIENT_SECRET &&
    config.CALENDAR_ENCRYPTION_KEY
      ? {
          client: createGoogleCalendarClient({
            clientId: config.GOOGLE_CALENDAR_CLIENT_ID,
            clientSecret: config.GOOGLE_CALENDAR_CLIENT_SECRET,
            publicUrl: config.PUBLIC_URL,
          }),
          encryptionKey: config.CALENDAR_ENCRYPTION_KEY,
        }
      : undefined
  const microsoftCalendar =
    config.MICROSOFT_CALENDAR_CLIENT_ID &&
    config.MICROSOFT_CALENDAR_CLIENT_SECRET &&
    config.CALENDAR_ENCRYPTION_KEY
      ? {
          client: createMicrosoftCalendarClient({
            clientId: config.MICROSOFT_CALENDAR_CLIENT_ID,
            clientSecret: config.MICROSOFT_CALENDAR_CLIENT_SECRET,
            publicUrl: config.PUBLIC_URL,
          }),
          encryptionKey: config.CALENDAR_ENCRYPTION_KEY,
        }
      : undefined
  const caldavPolicy = {
    privateTargets: config.CALDAV_PRIVATE_TARGETS,
    allowedOrigins: config.CALDAV_ALLOWED_ORIGINS,
  }
  const caldavCalendar = config.CALENDAR_ENCRYPTION_KEY
    ? {
        discoveryClient: createCalDavDiscovery(undefined, caldavPolicy),
        enqueueWritebackRecovery: (connectionId: string, transaction: Db): Promise<unknown> =>
          jobs.enqueue(
            'caldav-booking-recover',
            { connectionId, kind: 'booking' },
            { singletonKey: connectionId, transaction },
          ),
        syncClient: createCalDavSyncClient(undefined, caldavPolicy),
        encryptionKey: config.CALENDAR_ENCRYPTION_KEY,
        enqueueSync: (calendarId: string, transaction: Db): Promise<unknown> =>
          enqueueCalDavSync(calendarId, transaction),
      }
    : undefined
  const caldavSyncDeps: CalDavSyncDeps | undefined = caldavCalendar
    ? {
        db,
        client: caldavCalendar.syncClient,
        encryptionKey: caldavCalendar.encryptionKey,
      }
    : undefined
  const caldavWriteDeps = caldavCalendar
    ? {
        db,
        client: createCalDavWriteClient(undefined, caldavPolicy),
        encryptionKey: caldavCalendar.encryptionKey,
      }
    : undefined
  let enqueueCalDavSync: (calendarId: string, transaction?: Db) => Promise<unknown> = async () => {}
  const zoomConference =
    config.ZOOM_CLIENT_ID && config.ZOOM_CLIENT_SECRET && config.CONFERENCE_ENCRYPTION_KEY
      ? {
          client: createZoomClient({
            clientId: config.ZOOM_CLIENT_ID,
            clientSecret: config.ZOOM_CLIENT_SECRET,
            publicUrl: config.PUBLIC_URL,
          }),
          encryptionKey: config.CONFERENCE_ENCRYPTION_KEY,
          meetingsEnabled: config.ZOOM_MEETINGS_ENABLED,
        }
      : undefined
  const webhookSettings = {
    publicUrl: config.PUBLIC_URL,
    enabled: config.WEBHOOKS_ENABLED,
    workflowsEnabled,
    encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
    privateTargets: config.WEBHOOK_PRIVATE_TARGETS,
    ssoCapabilities: sso,
  }
  const calendarDeps: CalendarDeps = {
    db,
    google: googleCalendar,
    microsoft: microsoftCalendar,
    ...(zoomConference
      ? {
          zoomConferenceWork: createZoomConferenceWork(
            { db, zoom: zoomConference },
            createZoomMeetingsClient(),
          ),
        }
      : {}),
  }
  let enqueueConference: (id: string, group?: boolean) => Promise<unknown> = async () => {}
  let enqueueCalendar: (calendarId: string) => Promise<unknown> = async () => {}
  let enqueueBookingCalendar: (id: string) => Promise<unknown> = async () => {}
  let enqueueWritebackRecovery: (connectionId: string, after?: string) => Promise<unknown> =
    async () => {}
  // Background jobs: every role queues them, `all` and `worker` run them.
  const notificationDeps = {
    db,
    ssoCapabilities: sso,
    followUpHostNotesEnabled: config.FOLLOW_UP_HOST_NOTES_ENABLED,
    mailer,
    publicUrl: config.PUBLIC_URL,
    secret: config.BETTER_AUTH_SECRET,
    mailRecipientMaxPerHour: config.MAIL_RECIPIENT_MAX_PER_HOUR,
    mailRecipientMaxPerDay: config.MAIL_RECIPIENT_MAX_PER_DAY,
    mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
  }
  const invitationQueue: InvitationEmailQueue = {
    enqueue: (name, payload, options) => jobs.enqueue(name, payload, options),
    retireExpiredInvitationEmailJobs: (identity, transaction) =>
      jobs.retireExpiredInvitationEmailJobs(identity, transaction),
    hasLiveInvitationEmailJob: (identity, transaction) =>
      jobs.hasLiveInvitationEmailJob(identity, transaction),
  }
  const scheduledQueue: ScheduledEmailQueue = {
    enqueue: (name, payload, options) => jobs.enqueue(name, payload, options),
    hasLiveScheduledBookingEmailJob: (identity, transaction) =>
      jobs.hasLiveScheduledBookingEmailJob(identity, transaction),
    retireExpiredScheduledBookingEmailJobs: (identity, transaction) =>
      jobs.retireExpiredScheduledBookingEmailJobs(identity, transaction),
  }
  const invitationDeliveryDeps = { db, queue: invitationQueue }
  const repairInvitations = createInvitationEmailRepairer(invitationDeliveryDeps)
  const invitationMailLimits = {
    ...notificationDeps,
    invitationInviterMaxPerHour: config.INVITATION_INVITER_MAX_PER_HOUR,
    invitationInviterMaxPerDay: config.INVITATION_INVITER_MAX_PER_DAY,
    invitationTeamMaxPerHour: config.INVITATION_TEAM_MAX_PER_HOUR,
    invitationTeamMaxPerDay: config.INVITATION_TEAM_MAX_PER_DAY,
    invitationGlobalRecipientMultiplier: config.INVITATION_GLOBAL_RECIPIENT_MULTIPLIER,
  }
  const waitlistDeps = {
    db,
    scimResourcesEnabled: config.SCIM_PROVISIONING_ENABLED,
    secret: config.BETTER_AUTH_SECRET,
    publicUrl: config.PUBLIC_URL,
    automaticMeet: config.GOOGLE_MEET_ENABLED,
    automaticZoom: config.ZOOM_MEETINGS_ENABLED,
    microsoftCalendarEnabled: microsoftCalendar !== undefined,
  }
  const runWaitlistEmail = createWaitlistEmailWorker({
    ...notificationDeps,
    ...waitlistDeps,
    smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
    log: (line) => console.info(line),
  })
  const runMeetingPollEmail = createMeetingPollEmailWorker({
    ...notificationDeps,
    meetingPollSecret: config.BETTER_AUTH_SECRET,
    smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
    log: (line) => console.info(line),
  })
  const workflowWorker = { db, now: () => Temporal.Now.instant(), workflowsEnabled }
  const bulkCancellationEnabled = config.TEAM_BOOKING_BULK_CANCELLATION_ENABLED
  const enqueueBulkCancellation: EnqueueBulkCancellation = (transaction, batchId, startAfter) =>
    jobs.enqueue(
      TEAM_BOOKING_BULK_JOB,
      { batchId },
      { singletonKey: batchId, transaction, startAfter },
    )
  const enqueueDelayedBulkCancellation = (
    batchId: string,
    startAfter: Date,
  ): Promise<string | null> =>
    jobs.enqueue(TEAM_BOOKING_BULK_JOB, { batchId }, { singletonKey: batchId, startAfter })
  const enqueueDepartureHandoffRun: EnqueueDepartureHandoffRun = (
    transaction,
    organizationId,
    runId,
    startAfter,
  ) => enqueueDepartureHandoffRunJob(jobs, { organizationId, runId }, { transaction, startAfter })
  const workflowWakePort: WorkflowWakePort = {
    async ensureWake(trx, runId) {
      await jobs.enqueue(
        'workflow-dispatch-v1',
        { runId },
        { singletonKey: runId, transaction: trx },
      )
    },
  }
  const jobs = createJobs({
    connectionString: config.DATABASE_URL,
    disabledSchedules: [
      ...(ssoRetained(sso) ? [] : [SSO_DOMAIN_RECHECK_JOB]),
      ...(role !== 'web' && !runWorkflowJobs ? ['workflow-repair-v1'] : []),
      ...(bulkCancellationEnabled ? [] : [TEAM_BOOKING_BULK_RECOVERY_JOB]),
      ...(productionDepartureHandoffsEnabled ? [] : [DEPARTURE_HANDOFF_RUN_RECOVERY_JOB]),
    ],
    definitions: [
      ...teamBookingBulkCancellationJobs(db, {
        enabled: bulkCancellationEnabled,
        notify: (...args) => notify(...args),
        ssoCapabilities: sso,
        scimResourcesEnabled: config.SCIM_PROVISIONING_ENABLED,
        enqueue: enqueueBulkCancellation,
        enqueueDelayed: enqueueDelayedBulkCancellation,
      }),
      ssoDomainRecheckJob({
        db,
        publicUrl: config.PUBLIC_URL,
        capabilities: sso,
      }),
      ...waitlistMaintenanceJobs({
        scan: () => scanWaitlists(waitlistDeps),
        cleanup: () => cleanupWaitlist(waitlistDeps, { limit: 1000 }),
        continueCleanup: (): Promise<string | null> =>
          jobs.enqueue('waitlist-cleanup-v1', {}, { singletonKey: 'continuation' }),
      }),
      waitlistEmailJob(runWaitlistEmail),
      meetingPollEmailJob(runMeetingPollEmail),
      meetingPollCapabilityExpiryJob({
        cleanup: () => expireMeetingPollCapabilities(db, config.BETTER_AUTH_SECRET),
        continueCleanup: (): Promise<string | null> =>
          jobs.enqueue('meeting-poll-capability-expiry-v1', {}, { singletonKey: 'continuation' }),
      }),
      // No installation booking-data retention exists yet, so terminal polls stay until
      // explicit poll, linked-booking or organization deletion (docs/meeting-polls.md).
      meetingPollCleanupJob({
        cleanup: () => cleanupMeetingPolls(db),
        continueCleanup: (): Promise<string | null> =>
          jobs.enqueue('meeting-poll-cleanup-v1', {}, { singletonKey: 'continuation' }),
      }),
      oneTimeBookingLinksRetentionJob(db),
      auditLogRetentionJob((signal) =>
        purgeAuditEvents(db, { instance: config.AUDIT_LOG_RETENTION_DAYS, signal }),
      ),
      // Routing receipt and version cleanup runs whether or not routing is enabled.
      routingRetentionJob({
        purgeReceipts: async () => ({
          more: (await purgeExpiredRoutingReceipts(db)) === ROUTING_RECEIPT_PURGE_BATCH,
        }),
        cleanupVersions: (after) => deleteUnreferencedRoutingVersions(db, { after }),
        continueRetention: (payload): Promise<string | null> =>
          jobs.enqueue('routing-retention-v1', payload, { singletonKey: 'continuation' }),
      }),
      ...configuredSmsJobs(config, db),
      paymentHoldsExpiryJob(() => expirePaymentHolds({ db })),
      paymentRefundJob(db, config.stripe, options.stripeTransport),
      ...(config.MCP_OAUTH_ENABLED ? [mcpOAuthCleanupJob(db)] : []),
      ...signInEmailJobs({
        db,
        mailer,
        publicUrl: config.PUBLIC_URL,
        secret: config.BETTER_AUTH_SECRET,
        signup: config.signup,
        signInMailMaxPerHour: config.SIGN_IN_MAIL_MAX_PER_HOUR,
        signInMailMaxPerDay: config.SIGN_IN_MAIL_MAX_PER_DAY,
        mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
      }),
      // Mailbox proofs follow the relevant protocol setting. Cleanup runs in every state.
      ...mailboxProofJobs({
        capabilities: sso,
        ...(options.customRolesEnabled && { customRolesEnabled: true }),
        scimMappingConsentEnabled: config.SCIM_PROVISIONING_ENABLED,
        ownershipTransferEnabled: config.TEAM_OWNERSHIP_TRANSFER_ENABLED,
        db,
        mailer,
        publicUrl: config.PUBLIC_URL,
        secret: config.BETTER_AUTH_SECRET,
        signInMailMaxPerHour: config.SIGN_IN_MAIL_MAX_PER_HOUR,
        signInMailMaxPerDay: config.SIGN_IN_MAIL_MAX_PER_DAY,
        mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
      }),
      ssoLinkRemovalEmailJob({
        db,
        capabilities: sso,
        mailer,
      }),
      ssoRecoveryEnrollmentEmailJob({
        db,
        capabilities: sso,
        publicUrl: config.PUBLIC_URL,
        mailer,
      }),
      ownershipTransferNoticeJob({ db, publicUrl: config.PUBLIC_URL, mailer }),
      ssoOperatorRecoveryEmailJob(
        db,
        config.SMTP_URL && config.MAIL_FROM ? mailer : undefined,
        config.SCIM_PROVISIONING_ENABLED,
      ),
      scimMappingNoticeJob(db, mailer),
      bookingNotificationJob(notificationDeps),
      departureHandoffEmailJob(productionDepartureHandoffsEnabled ? notificationDeps : undefined),
      ...departureHandoffRunJobs(
        db,
        productionDepartureHandoffsEnabled
          ? {
              notify: (...args) => notify(...args),
              ssoCapabilities: sso,
              scimResourcesEnabled: config.SCIM_PROVISIONING_ENABLED,
              automaticMeet: config.GOOGLE_MEET_ENABLED,
              automaticZoom: config.ZOOM_MEETINGS_ENABLED,
              microsoftCalendarEnabled: microsoftCalendar !== undefined,
              enqueue: enqueueDepartureHandoffRun,
              enqueueDelayed: (args, startAfter): Promise<string | null> =>
                enqueueDepartureHandoffRunJob(jobs, args, { startAfter }),
            }
          : undefined,
      ),
      ...(productionDepartureHandoffsEnabled
        ? [
            departureHandoffCleanupJob(() =>
              cleanupDepartureHandoffProposals(db, Temporal.Now.instant()),
            ),
          ]
        : []),
      rescheduleRequestExpiryJob({
        db,
        notify: async (trx, event, now) => {
          await bookingNotifier(jobs)(trx, event, now)
          await webhookBookingNotifier(jobs, webhookSettings)(trx, event, now)
        },
      }),
      groupHostMailJob(notificationDeps),
      scheduledBookingEmailJob(notificationDeps),
      scheduledBookingEmailRepairJob(notificationDeps, scheduledQueue),
      conferenceNotificationDispatchJob(notificationDeps),
      seriesNotificationDispatchJob(notificationDeps),
      notificationEmailCleanupJob(notificationDeps),
      invitationEmailJob({
        ...notificationDeps,
        smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
      }),
      invitationEmailRepairJob(repairInvitations),
      bookingConferenceJob(calendarDeps),
      conferenceDispatchJob(calendarDeps, (id, group) => enqueueConference(id, group)),
      conferenceMirrorDispatchJob(calendarDeps, (id) => enqueueBookingCalendar(id)),
      webhookDeliveryJob({ db, ...webhookSettings }),
      webhookCleanupJob(db),
      ...(runWorkflowJobs
        ? workflowJobs(
            workflowWorker,
            workflowWakePort,
            (): Promise<string | null> =>
              jobs.enqueue('workflow-retention-v1', {}, { singletonKey: 'retention' }),
            (claim) =>
              executeWorkflowClaim(
                {
                  ...workflowWorker,
                  mailer,
                  scimResourcesEnabled: config.SCIM_PROVISIONING_ENABLED,
                  budget: {
                    secret: config.BETTER_AUTH_SECRET,
                    mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
                    workflowMailMaxPerHour: config.WORKFLOW_MAIL_MAX_PER_HOUR,
                    workflowOwnerMailMaxPerHour: config.WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
                  },
                  followUpHostNotesEnabled: () => config.FOLLOW_UP_HOST_NOTES_ENABLED,
                  captureWebhook: (trx, input, now): Promise<boolean> =>
                    captureWorkflowWebhook(jobs, webhookSettings, trx, input, now),
                },
                claim,
              ),
          )
        : []),
      ...(caldavSyncDeps && caldavWriteDeps
        ? [
            calDavSyncJob(caldavSyncDeps),
            calDavDispatchJob(caldavSyncDeps, (id) => enqueueCalDavSync(id)),
            calDavBookingJob(caldavWriteDeps),
            calDavRecoveryJob(
              db,
              (payload, transaction): Promise<unknown> =>
                jobs.enqueue('caldav-booking', payload, {
                  transaction,
                  singletonKey:
                    'bookingId' in payload ? payload.bookingId : `group:${payload.groupSlotId}`,
                }),
              (payload, transaction): Promise<unknown> =>
                jobs.enqueue('caldav-booking-recover', payload, {
                  transaction,
                  singletonKey: payload.connectionId,
                }),
            ),
          ]
        : []),
      calendarSyncJob(calendarDeps),
      bookingCalendarJob(calendarDeps),
      bookingCalendarRecoveryJob(
        calendarDeps,
        (id, trx): Promise<unknown> =>
          jobs.enqueue(
            'booking-calendar',
            { bookingId: id },
            { singletonKey: id, transaction: trx },
          ),
        (connectionId, after) => enqueueWritebackRecovery(connectionId, after),
      ),
      calendarDispatchJob(
        calendarDeps,
        (id) => enqueueCalendar(id),
        (payload): Promise<unknown> =>
          jobs.enqueue('booking-calendar', payload, {
            singletonKey:
              'bookingId' in payload ? payload.bookingId : `group:${payload.groupSlotId}`,
          }),
      ),
    ],
    work: role !== 'web',
    // pg-boss installs and upgrades its own `pgboss` schema; with AUTO_MIGRATE=false,
    // `npm run db:migrate` does that too.
    migrate: config.AUTO_MIGRATE,
    instanceName: role,
  })
  enqueueCalDavSync = createCalDavSyncEnqueuer(jobs)
  enqueueBookingCalendar = (id) =>
    jobs.enqueue('booking-calendar', { bookingId: id }, { singletonKey: id })
  enqueueWritebackRecovery = (connectionId, after) =>
    jobs.enqueue(
      'booking-calendar-recover',
      { connectionId, ...(after ? { after } : {}) },
      { singletonKey: connectionId },
    )
  enqueueCalendar = (id) => jobs.enqueue('calendar-sync', { calendarId: id }, { singletonKey: id })
  enqueueConference = (id, group = false) =>
    jobs.enqueue('booking-conference', group ? { groupSlotId: id } : { rootBookingId: id }, {
      singletonKey: group ? `group:${id}` : id,
    })
  // REST, MCP and booking workers use the same transactional booking side effects.
  const emailNotifier = bookingNotifier(jobs)
  const calendarNotifier = calendarBookingNotifier(jobs, { google: Boolean(googleCalendar) })
  const caldavNotifier = calDavBookingNotifier(jobs)
  const conferenceNotifier = conferenceBookingNotifier(jobs)
  const notifyAttendeeNoShow = webhookAttendeeNoShowNotifier(jobs, webhookSettings)
  const webhookNotifier = webhookBookingNotifier(jobs, webhookSettings)
  const notify: BookingNotifier = async (trx, event, now) => {
    if (!('requestId' in event)) await conferenceNotifier(trx, event)
    await emailNotifier(trx, event, now)
    if (!('requestId' in event)) await calendarNotifier(trx, event)
    if (caldavCalendar && !('requestId' in event)) await caldavNotifier(trx, event)
    await webhookNotifier(trx, event, now)
    // Core notification intents precede workflow capture in the booking's transaction.
    await captureWorkflowBooking(trx, event, now, config.BETTER_AUTH_SECRET, { workflowsEnabled })
  }
  try {
    await jobs.start()
  } catch (err) {
    try {
      await jobs.stop()
    } finally {
      await Promise.all([db.destroy(), authPool?.end()])
    }
    throw err
  }
  if (role !== 'web') {
    if (runWorkflowJobs) {
      try {
        await jobs.enqueue('workflow-repair-v1', {}, { singletonKey: 'startup' })
      } catch {
        console.error('ERROR workflow-repair: startup_repair_unavailable')
      }
    }
    try {
      await scanWaitlists(waitlistDeps)
      await jobs.enqueue('waitlist-email-v1', {}, { singletonKey: 'delivery' })
      await jobs.enqueue('waitlist-cleanup-v1', {}, { singletonKey: 'continuation' })
    } catch {
      console.error('ERROR waitlist-maintenance: startup_scan_unavailable')
    }
    try {
      await repairScheduledBookingEmails(notificationDeps, scheduledQueue)
    } catch {
      console.error('ERROR scheduled-booking-email-repair: startup_repair_unavailable')
    }
    try {
      await repairInvitations()
    } catch {
      // The every-minute job retries reconciliation without blocking the other workers.
      console.error(
        `${new Date().toISOString()} ERROR invitation-email-repair-v1: startup_repair_unavailable; scheduled repair will retry`,
      )
    }
  }
  const checkDb = async () => {
    await sql`SELECT 1`.execute(db)
  }

  let fetch: Parameters<typeof serve>[0]['fetch']
  if (!authPool) {
    fetch = createWorkerHealthApp({ checkDb, checkJobs: () => jobs.check() }).fetch
  } else {
    const stripe = config.stripe
    const stripeAccountVerified =
      config.PAID_BOOKINGS_ENABLED && stripe?.mode === 'test'
        ? await createStripeClient(stripe, options.stripeTransport)
            .accounts.retrieveCurrent()
            .then(
              ({ id }) => id === stripe.accountId,
              () => false,
            )
        : false
    const auth = createAuth({
      ...productionAuthOptions({
        config,
        pool: authPool,
        db,
        mailer: countingMailer,
        invitationDelivery: invitationDeliveryDeps,
        invitationMailLimits,
        jobs,
      }),
      organizationListRateLimitMaxForTests: options.organizationListRateLimitMaxForTests,
      customRolesEnabled: options.customRolesEnabled,
    })
    // db is closed below.
    fetch = createApp(
      productionAppOptions({
        config,
        stripeTransport: options.stripeTransport,
        stripeAccountVerified,
        customRolesEnabled: options.customRolesEnabled,
        routingFormsEnabled,
        recurringBookingsEnabled: recurringBookingAdmissionEnabled(options),
        db,
        auth,
        resolveCaller: createCallerResolver({
          auth,
          db,
          ssoCapabilities: sso,
          customRolesEnabled: options.customRolesEnabled,
        }),
        resolveMcpOAuth: createMcpOAuthResolver({
          auth,
          db,
          publicUrl: config.PUBLIC_URL,
          ssoCapabilities: sso,
          customRolesEnabled: options.customRolesEnabled,
        }),
        checkDb,
        waitlist: {
          verify: (token) => verifyWaitlist(waitlistDeps, { token }),
          remove: (token) => removeWaitlist(waitlistDeps, { token }),
        },
        invitationMailLimits,
        webhookSettings,
        enqueueDepartureHandoffEmail: createDepartureHandoffEmailQueue(jobs),
        enqueueDepartureHandoffRun,
        enqueueScimInvitation: createInvitationEmailDispatcher(invitationDeliveryDeps),
        webhookQueue: jobs,
        notify,
        notifyAttendeeNoShow,
        enqueueBulkCancellation,
        googleCalendar,
        microsoftCalendar,
        caldavCalendar,
        zoomConference,
        enqueueCalendarSync: (id, trx) =>
          jobs.enqueue('calendar-sync', { calendarId: id }, { singletonKey: id, transaction: trx }),
        enqueueCalendarWritebackRecovery: (connectionId, trx) =>
          jobs.enqueue(
            'booking-calendar-recover',
            { connectionId },
            { singletonKey: connectionId, transaction: trx },
          ),
        mailboxProofQueue: jobs,
        ownershipTransferNoticeQueue: jobs,
        scimMappingNotices: jobs,
        ssoLinkRemovalQueue: jobs,
        ssoRecoveryEnrollmentQueue: jobs,
      }),
    ).fetch
  }

  let closing = false
  const server = await new Promise<Server>((resolve, reject) => {
    const serverOptions = httpServerOptions(config.httpTimeouts)
    const answer = closeConnectionsWhen(() => closing, fetch)
    // An http.Server: serve() makes one unless given a createServer.
    const onError = (error: Error) => reject(error)
    const s = serve({ fetch: answer, port: config.PORT, serverOptions }, (info: AddressInfo) => {
      s.removeListener('error', onError)
      if (role === 'worker') {
        console.log(`Hourmere worker running jobs; health check on :${info.port}/api/health`)
      } else {
        const providers = Object.keys(config.socialProviders)
        const { mode, allowedDomains } = config.signup
        const signup = `${mode}${allowedDomains.length ? `, plus ${allowedDomains.join(', ')}` : ''}`
        console.log(
          `Hourmere listening on :${info.port} (${config.PUBLIC_URL}); sign-in: email${providers.map((p) => `, ${p}`).join('')}; sign-up: ${signup}; jobs: ${role === 'all' ? 'run here' : 'queued for a worker'}`,
        )
      }
      resolve(s as Server)
    })
    s.once('error', onError)
  }).catch(async (error: unknown) => {
    // Jobs already started before listen. A bind failure must not leave an invisible
    // consumer or database pool running when startServer rejects inside another process.
    await Promise.allSettled([jobs.stop()])
    await Promise.allSettled([db.destroy(), authPool?.end()])
    throw error
  })

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Requests first (one still running may queue a job), then jobs (waiting for running
        // ones up to a timeout), then the pools the jobs use. Kept-alive connections do not
        // hold this up (see shutdown.ts).
        closing = true
        const afterRequests = async (err?: unknown) => {
          try {
            if (sending)
              console.warn(`shutting down: dropping ${sending} email(s) still being sent`)
            await jobs.stop().finally(() => Promise.all([db.destroy(), authPool?.end()]))
            restoreConsole()
            if (err) reject(err)
            else resolve()
          } catch (closeErr) {
            reject(closeErr)
          }
        }
        closeServer(server).then(() => afterRequests(), afterRequests)
      }),
  }
}
