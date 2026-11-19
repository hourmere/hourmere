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
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  createMeetingPollEmailWorker,
  createWaitlistEmailWorker,
  groupHostMailJob,
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
  signInEmailJobs,
  waitlistEmailJob,
} from '@hourmere/notifications'
import type { ServiceContext } from '@hourmere/scheduling'
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
  type WebhookQueue,
  type WebhookSettings,
  webhookAttendeeNoShowNotifier,
  webhookBookingNotifier,
  webhookCleanupJob,
  webhookDeliveryJob,
} from '@hourmere/webhooks'
import { captureWorkflowBooking } from '@hourmere/workflows'
import { sql } from 'kysely'
import { type AppDeps, createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import { httpServerOptions } from './http-timeouts.ts'
import { auditLogTools } from './mcp/audit-log.ts'
import { availabilityTroubleshootingTools } from './mcp/availability-troubleshooting.ts'
import { bookingTools } from './mcp/bookings.ts'
import { brandingTools } from './mcp/branding.ts'
import { catalogTools } from './mcp/catalog.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { eventTypeTools } from './mcp/event-types.ts'
import { integrationTools } from './mcp/integrations.ts'
import { meetingPollHostTools } from './mcp/meeting-poll-host.ts'
import { meetingPollTools } from './mcp/meeting-polls.ts'
import { mcpOAuthCleanupJob, mcpOAuthRoutes } from './mcp/oauth.ts'
import { oneTimeLinkTools } from './mcp/one-time-links.ts'
import { openTimeSnippetTools } from './mcp/open-time-snippets.ts'
import { routingFormConfigurationTools } from './mcp/routing-forms.ts'
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
import { analyticsRoutes } from './routes/analytics.ts'
import { auditLogRoutes } from './routes/audit-log.ts'
import { availabilityTroubleshootingRoutes } from './routes/availability-troubleshooting.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { brandingRoutes } from './routes/branding.ts'
import { caldavRoutes } from './routes/caldav.ts'
import { calendarRoutes } from './routes/calendars.ts'
import { conferenceRoutes } from './routes/conferences.ts'
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
import { profileRoutes } from './routes/profile.ts'
import { provisioningTokenRoutes } from './routes/provisioning-tokens.ts'
import { publicRoutes } from './routes/public.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { routingFormRoutes } from './routes/routing-forms.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { slackDestinationRoutes } from './routes/slack-destinations.ts'
import { ssoRoutes } from './routes/sso.ts'
import { ssoDomainRoutes } from './routes/sso-domains.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { workflowRoutes } from './routes/workflows.ts'
import { zoomEventRoutes } from './routes/zoom-events.ts'
import { closeConnectionsWhen, closeServer } from './shutdown.ts'
import { configuredSmsJobs, createConfiguredSmsInbound } from './sms.ts'
import { SSO_DOMAIN_RECHECK_JOB, ssoDomainRecheckJob } from './sso-domain-recheck.ts'
import {
  type MailboxProofQueue,
  mailboxProofJobs,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
import { type OidcProviderTestDeps, oidcSignInRoutes } from './sso-oidc-sign-in.ts'
import type { InvitationSummaryMailLimits } from './team-invitations.ts'
import { createWorkerHealthApp } from './worker-health.ts'

// Hard-off until each protocol completes its rollout. Production never overrides these;
// only in-process tests inject enabled capabilities into productRoutes.
const ssoOidcEnabled = false
const ssoSamlEnabled = false
// Routing forms are hard-off in code until their operator setting lands
// (docs/routing-forms.md, Rollout gating): no environment variable or other setting reads
// this, and production never overrides it; only in-process tests inject `true`.
const routingFormsEnabled = false

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
  slotSnippetsEnabled = false,
  ssoConfigurationKey,
  ssoPrivateTargets,
  ssoOidcEnabled: oidcEnabled = ssoOidcEnabled,
  ssoSamlEnabled: samlEnabled = ssoSamlEnabled,
  routingFormsEnabled: routingEnabled = routingFormsEnabled,
  successRedirectAllowIpHosts = false,
  successRedirectPolicy = { publicUrl, allowIpHosts: successRedirectAllowIpHosts },
  bookingMaxInviteeReschedules,
  bookingExportMaxConcurrent,
  hostedSignupUrl,
  privacyPolicyUrl,
  termsUrl,
  invitationMailLimits,
  waitlistSecret,
  meetingPollSecret,
  routingSecret,
  smtpConfigured,
  recurringBookingsEnabled,
  auditLogRetentionDays = null,
}: {
  db: Db
  /** AUDIT_LOG_RETENTION_DAYS: days, or null (the default) to keep events forever. */
  auditLogRetentionDays?: number | null
  automaticMeet?: boolean
  automaticZoom?: boolean
  followUpHostNotesEnabled?: boolean
  smsRemindersAvailable?: boolean
  embedAllowedOrigins?: readonly string[]
  scimProvisioningEnabled?: boolean
  slotSnippetsEnabled?: boolean
  /** Operator-managed key for encrypted provider configuration; does not enable SSO. */
  ssoConfigurationKey?: Buffer | undefined
  ssoPrivateTargets?: OidcProviderTestDeps['privateTargets']
  /** In-process test injection only; no operator setting exists during hard-off. */
  ssoOidcEnabled?: boolean
  /** In-process test injection only; no operator setting exists during hard-off. */
  ssoSamlEnabled?: boolean
  /** In-process test injection only; no operator setting exists during hard-off. */
  routingFormsEnabled?: boolean
  successRedirectAllowIpHosts?: boolean
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
  bookingMaxInviteeReschedules?: number | undefined
  bookingExportMaxConcurrent?: number | undefined
  hostedSignupUrl?: string
  privacyPolicyUrl?: string
  termsUrl?: string
  invitationMailLimits: InvitationSummaryMailLimits
  waitlistSecret?: string | undefined
  meetingPollSecret?: string | undefined
  routingSecret?: string | undefined
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
} & RecurringBookingAdmissionDeps): RouteModule[] {
  return [
    mcpOAuthRoutes({ auth: mcpAuth, db, publicUrl }),
    instanceRoutes({
      publicUrl,
      socialProviders,
      scimProvisioningEnabled,
      automaticMeet,
      smsRemindersAvailable,
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
    webhookRoutes({ db, ...webhooks }),
    brandingRoutes({ db }),
    auditLogRoutes({ db, auditLogRetentionDays }),
    ssoRoutes({ db, capabilities: { ssoOidcEnabled: oidcEnabled, ssoSamlEnabled: samlEnabled } }),
    ssoDomainRoutes({
      db,
      publicUrl,
      capabilities: { ssoOidcEnabled: oidcEnabled, ssoSamlEnabled: samlEnabled },
    }),
    ssoDraftRoutes({
      db,
      publicUrl,
      configurationKey: ssoConfigurationKey,
      privateTargets: ssoPrivateTargets,
      capabilities: { ssoOidcEnabled: oidcEnabled, ssoSamlEnabled: samlEnabled },
    }),
    slackDestinationRoutes({ db, ...webhooks, queue: webhookQueue }),
    eventTypeRoutes({
      db,
      followUpHostNotesEnabled,
      smsRemindersAvailable,
      automaticMeet,
      automaticZoom,
      successRedirectPolicy,
      recurringBookingsEnabled,
    }),
    meetingPollRoutes({ db, meetingPollSecret }),
    meetingPollHostRoutes({
      db,
      meetingPollSecret,
      notify,
      automaticMeet,
      automaticZoom,
      smsRemindersAvailable,
    }),
    publicRoutes({
      db,
      routingFormsEnabled: routingEnabled,
      routingSecret,
      smsRemindersAvailable,
      waitlistSecret,
      smtpConfigured,
      publicUrl,
      notify,
      automaticMeet,
      automaticZoom,
      successRedirectPolicy,
    }),
    oneTimeBookingRoutes({
      db,
      smsRemindersAvailable,
      notify,
      automaticMeet,
      automaticZoom,
      successRedirectPolicy,
    }),
    oneTimeLinkRoutes({ db, publicUrl }),
    openTimeSnippetRoutes({ db, publicUrl, slotSnippetsEnabled, automaticMeet, automaticZoom }),
    routingFormRoutes({ db, routingFormsEnabled: routingEnabled }),
    availabilityTroubleshootingRoutes({ db, automaticMeet, automaticZoom }),
    bookingRoutes({
      db,
      smsRemindersAvailable,
      notify,
      notifyAttendeeNoShow,
      automaticMeet,
      automaticZoom,
      bookingMaxInviteeReschedules,
      bookingExportMaxConcurrent,
    }),
    teamBookingRoutes({ db, notify }),
    teamInvitationRoutes({ db, invitationMailLimits }),
    memberDepartureImpactRoutes({ db }),
    memberRemovalRoutes({
      db,
      recordAdmissionRemoval: oidcEnabled ? recordSsoAdmissionRemoval : undefined,
    }),
    memberLeaveRoutes({
      db,
      recordAdmissionRemoval: oidcEnabled ? recordSsoAdmissionRemoval : undefined,
    }),
    analyticsRoutes({ db }),
    readinessRoutes({ db, automaticMeet, automaticZoom }),
    // Registered while hard-off: every operation answers 404 workflows_disabled.
    workflowRoutes({ db, followUpHostNotesEnabled }),
  ]
}

/** The same tool registry is used by the running server and capability contract tests. */
export function productTools({
  db,
  webhooks = { enabled: false },
  webhookQueue,
  waitlistSecret,
  meetingPollSecret,
  routingSecret,
  smtpConfigured,
  publicUrl,
  slotSnippetsEnabled = false,
  routingFormsEnabled: routingEnabled = routingFormsEnabled,
  followUpHostNotesEnabled,
  smsRemindersAvailable = false,
  successRedirectPolicy,
  notify,
  notifyAttendeeNoShow,
  automaticMeet,
  automaticZoom,
  bookingMaxInviteeReschedules,
  googleCalendar,
  caldavCalendar,
  zoomConference,
  auditLogRetentionDays = null,
}: {
  db: Db
  /** AUDIT_LOG_RETENTION_DAYS: days, or null (the default) to keep events forever. */
  auditLogRetentionDays?: number | null
  webhooks?: import('@hourmere/webhooks').WebhookSettings
  webhookQueue?: import('@hourmere/webhooks').WebhookQueue | undefined
  waitlistSecret?: string | undefined
  meetingPollSecret?: string | undefined
  routingSecret?: string | undefined
  smtpConfigured?: boolean | undefined
  slotSnippetsEnabled?: boolean | undefined
  routingFormsEnabled?: boolean | undefined
  publicUrl?: string | undefined
  smsRemindersAvailable?: boolean | undefined
  followUpHostNotesEnabled?: boolean | undefined
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
  notifyAttendeeNoShow?: AttendeeNoShowNotifier | undefined
  notify?: BookingNotifier | undefined
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  bookingMaxInviteeReschedules?: number | undefined
  googleCalendar?: CalendarDeps['google']
  caldavCalendar?: CalendarDeps['caldav']
  zoomConference?: ConferenceDeps['zoom']
}): Tool[] {
  return [
    whoamiTool,
    ...bookingTools({
      db,
      waitlistSecret,
      smtpConfigured,
      smsRemindersAvailable,
      notify,
      notifyAttendeeNoShow,
      automaticMeet,
      automaticZoom,
      bookingMaxInviteeReschedules,
    }),
    ...catalogTools({ db, followUpHostNotesEnabled, smsRemindersAvailable }),
    ...brandingTools({ db }),
    ...auditLogTools({ db, auditLogRetentionDays }),
    ...eventTypeTools({
      db,
      automaticMeet,
      automaticZoom,
      smsRemindersAvailable,
      followUpHostNotesEnabled,
      successRedirectPolicy,
    }),
    ...oneTimeLinkTools({ db, publicUrl }),
    ...slackDestinationTools({ db, ...webhooks, queue: webhookQueue }),
    ...webhookTools({ db, ...webhooks }),
    ...(slotSnippetsEnabled
      ? openTimeSnippetTools({ db, publicUrl, slotSnippetsEnabled, automaticMeet, automaticZoom })
      : []),
    ...availabilityTroubleshootingTools({ db, automaticMeet, automaticZoom }),
    ...integrationTools({
      calendar: { db, google: googleCalendar, caldav: caldavCalendar },
      conference: { db, zoom: zoomConference },
    }),
    ...meetingPollTools({ db, meetingPollSecret }),
    ...meetingPollHostTools({
      db,
      meetingPollSecret,
      notify,
      automaticMeet,
      automaticZoom,
      smsRemindersAvailable,
    }),
    ...waitlistTools({ db, secret: waitlistSecret, publicUrl, smtpConfigured }),
    // Always in the catalog; hidden from tools/list and refused while workflows are off.
    ...workflowTools({ db, followUpHostNotesEnabled }),
    ...ssoReadTools({ db, capabilities: { ssoOidcEnabled, ssoSamlEnabled } }),
    ...routingFormConfigurationTools({
      db,
      routingFormsEnabled: routingEnabled,
      routingSecret,
      publicUrl,
    }),
  ]
}

/** What the running server's app options need beyond the configuration. */
export interface ProductionAppDeps extends RecurringBookingAdmissionDeps {
  config: Config
  db: Db
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
  /** The job queue SSO mailbox proof emails are enqueued on. */
  mailboxProofQueue: MailboxProofQueue
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
  auth,
  resolveCaller,
  resolveMcpOAuth,
  checkDb,
  waitlist,
  invitationMailLimits,
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
  mailboxProofQueue,
  recurringBookingsEnabled,
}: ProductionAppDeps): AppDeps {
  // All configuration transports and public booking routes share the instance policy.
  const successRedirectPolicy = {
    publicUrl: config.PUBLIC_URL,
    allowIpHosts: config.SUCCESS_REDIRECT_ALLOW_IP_HOSTS,
  }
  const ssoConfigurationKey = config.SSO_ENCRYPTION_KEY
    ? Buffer.from(config.SSO_ENCRYPTION_KEY, 'base64')
    : undefined
  const ssoPrivateTargets = config.SSO_PRIVATE_TARGETS
  return {
    checkDb,
    scim: { db, enabled: config.SCIM_PROVISIONING_ENABLED },
    smsInbound: createConfiguredSmsInbound(config, db),
    authHandler: auth.handler,
    resolveCaller,
    publicUrl: config.PUBLIC_URL,
    embedOrigins: config.EMBED_ALLOWED_ORIGINS,
    hstsMaxAge: config.HSTS_MAX_AGE,
    trustedProxies: config.trustedProxies,
    webDist: config.WEB_DIST,
    waitlist,
    ssoMe: { capabilities: { ssoOidcEnabled, ssoSamlEnabled }, db },
    // Mounted in every state: while hard-off both endpoints answer 404 sso_disabled.
    ssoMailboxProof: mailboxProofRoutes({
      capabilities: { ssoOidcEnabled, ssoSamlEnabled },
      db,
      queue: mailboxProofQueue,
    }),
    ssoOidcSignIn: oidcSignInRoutes({
      capabilities: { ssoOidcEnabled, ssoSamlEnabled },
      db,
      configurationKey: ssoConfigurationKey,
      privateTargets: ssoPrivateTargets,
      signup: config.signup,
      session: { secret: config.BETTER_AUTH_SECRET },
      readSession: async (headers) =>
        (
          await auth.api?.getSession({
            headers,
            query: { disableRefresh: true, disableCookieCache: true },
          })
        )?.session,
    }),
    // db is closed by the caller.
    routes: productRoutes({
      ssoConfigurationKey,
      ssoPrivateTargets,
      scimProvisioningEnabled: config.SCIM_PROVISIONING_ENABLED,
      mcpAuth: config.MCP_OAUTH_ENABLED ? auth : undefined,
      publicUrl: config.PUBLIC_URL,
      db,
      invitationMailLimits,
      waitlistSecret: config.BETTER_AUTH_SECRET,
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
      successRedirectPolicy,
      bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
      bookingExportMaxConcurrent: config.BOOKING_EXPORT_MAX_CONCURRENT,
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
      routingSecret: config.BETTER_AUTH_SECRET,
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
        smsRemindersAvailable: config.SMS_PROVIDER === 'twilio',
        smtpConfigured: Boolean(config.SMTP_URL && config.MAIL_FROM),
        notify,
        notifyAttendeeNoShow,
        automaticMeet: config.GOOGLE_MEET_ENABLED,
        automaticZoom: config.ZOOM_MEETINGS_ENABLED,
        bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
        auditLogRetentionDays: config.AUDIT_LOG_RETENTION_DAYS,
        googleCalendar,
        caldavCalendar,
        zoomConference,
        webhooks: webhookSettings,
        webhookQueue,
        routingSecret: config.BETTER_AUTH_SECRET,
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
  const recordAdmissionRemoval = ssoOidcEnabled ? recordSsoAdmissionRemoval : undefined
  return {
    pool,
    db,
    leaveTeamMember: nativeTeamLeave(db, recordAdmissionRemoval),
    recordAdmissionRemoval,
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

/** Starts Hourmere from environment variables (see .env.example) and optional test dependencies. */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  options: RecurringBookingAdmissionDeps = {},
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
  options: RecurringBookingAdmissionDeps,
  restoreConsole: () => void,
): Promise<RunningServer> {
  const config = loadConfig(env)
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

  try {
    await db.transaction().execute((trx) => ensureWaitlistKey(trx, config.BETTER_AUTH_SECRET))
    await db.transaction().execute((trx) => ensureMeetingPollKey(trx, config.BETTER_AUTH_SECRET))
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

  const role = config.HOURMERE_ROLE
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
    encryptionKey: config.WEBHOOK_ENCRYPTION_KEY,
    privateTargets: config.WEBHOOK_PRIVATE_TARGETS,
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
  }
  const waitlistDeps = {
    db,
    secret: config.BETTER_AUTH_SECRET,
    publicUrl: config.PUBLIC_URL,
    automaticMeet: config.GOOGLE_MEET_ENABLED,
    automaticZoom: config.ZOOM_MEETINGS_ENABLED,
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
  const jobs = createJobs({
    connectionString: config.DATABASE_URL,
    disabledSchedules: ssoOidcEnabled || ssoSamlEnabled ? [] : [SSO_DOMAIN_RECHECK_JOB],
    definitions: [
      ssoDomainRecheckJob({
        db,
        publicUrl: config.PUBLIC_URL,
        capabilities: { ssoOidcEnabled, ssoSamlEnabled },
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
      // Delivery drops every job while hard-off; the attempt cleanup only deletes, so it runs
      // in every state.
      ...mailboxProofJobs({
        capabilities: { ssoOidcEnabled, ssoSamlEnabled },
        db,
        mailer,
        publicUrl: config.PUBLIC_URL,
        secret: config.BETTER_AUTH_SECRET,
        signInMailMaxPerHour: config.SIGN_IN_MAIL_MAX_PER_HOUR,
        signInMailMaxPerDay: config.SIGN_IN_MAIL_MAX_PER_DAY,
        mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
      }),
      bookingNotificationJob(notificationDeps),
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
      calendarDispatchJob(calendarDeps, (id) => enqueueCalendar(id)),
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
    // Booking changes over REST and MCP queue their emails in their own transactions.
    const emailNotifier = bookingNotifier(jobs)
    const calendarNotifier = calendarBookingNotifier(jobs)
    const caldavNotifier = calDavBookingNotifier(jobs)
    const conferenceNotifier = conferenceBookingNotifier(jobs)
    const notifyAttendeeNoShow = webhookAttendeeNoShowNotifier(jobs, webhookSettings)
    const webhookNotifier = webhookBookingNotifier(jobs, webhookSettings)
    const notify: BookingNotifier = async (trx, event, now) => {
      if (!('requestId' in event)) await conferenceNotifier(trx, event)
      await emailNotifier(trx, event, now)
      if (googleCalendar && !('requestId' in event)) await calendarNotifier(trx, event)
      if (caldavCalendar && !('requestId' in event)) await caldavNotifier(trx, event)
      await webhookNotifier(trx, event, now)
      // Core notification intents precede workflow capture in the booking's transaction.
      await captureWorkflowBooking(trx, event, now, config.BETTER_AUTH_SECRET)
    }
    const auth = createAuth(
      productionAuthOptions({
        config,
        pool: authPool,
        db,
        mailer: countingMailer,
        invitationDelivery: invitationDeliveryDeps,
        invitationMailLimits,
        jobs,
      }),
    )
    // db is closed below.
    fetch = createApp(
      productionAppOptions({
        config,
        recurringBookingsEnabled: recurringBookingAdmissionEnabled(options),
        db,
        auth,
        resolveCaller: createCallerResolver({ auth, db }),
        resolveMcpOAuth: createMcpOAuthResolver({ auth, db, publicUrl: config.PUBLIC_URL }),
        checkDb,
        waitlist: {
          verify: (token) => verifyWaitlist(waitlistDeps, { token }),
          remove: (token) => removeWaitlist(waitlistDeps, { token }),
        },
        invitationMailLimits,
        webhookSettings,
        webhookQueue: jobs,
        notify,
        notifyAttendeeNoShow,
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
