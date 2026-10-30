// Install the schema extension before scheduling constructs shared response schemas.
import '@hono/zod-openapi'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import {
  assertSignupEnforced,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
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
import { type ConferenceDeps, createZoomClient } from '@hourmere/conferences'
import { createZoomConferenceWork } from '@hourmere/conferences/worker'
import { createZoomMeetingsClient } from '@hourmere/conferences/zoom-meetings'
import { createDb, createPool, type Db, runMigrations } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { createLogMailer, createSmtpMailer, type Mailer } from '@hourmere/mail'
import {
  bookingNotificationJob,
  bookingNotifier,
  conferenceNotificationDispatchJob,
  createInvitationEmailDispatcher,
  createInvitationEmailRepairer,
  type InvitationEmailQueue,
  invitationEmailJob,
  invitationEmailRepairJob,
  notificationEmailCleanupJob,
  queuedSignInEmail,
  reserveInvitationEmailBudget,
  signInEmailJobs,
} from '@hourmere/notifications'
import { type BookingNotifier, leaveTeamMember } from '@hourmere/scheduling'
import { webhookBookingNotifier, webhookCleanupJob, webhookDeliveryJob } from '@hourmere/webhooks'
import { sql } from 'kysely'
import { createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import { httpServerOptions } from './http-timeouts.ts'
import { bookingTools } from './mcp/bookings.ts'
import { catalogTools } from './mcp/catalog.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { integrationTools } from './mcp/integrations.ts'
import { mcpOAuthCleanupJob, mcpOAuthRoutes } from './mcp/oauth.ts'
import type { Tool } from './mcp/tools.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { installOneLineConsole } from './one-line-console.ts'
import type { RouteModule } from './openapi.ts'
import { analyticsRoutes } from './routes/analytics.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { calendarRoutes } from './routes/calendars.ts'
import { conferenceRoutes } from './routes/conferences.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { instanceRoutes } from './routes/instance.ts'
import { memberDepartureImpactRoutes } from './routes/member-departure-impact.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { profileRoutes } from './routes/profile.ts'
import { publicRoutes } from './routes/public.ts'
import { readinessRoutes } from './routes/readiness.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { zoomEventRoutes } from './routes/zoom-events.ts'
import { closeConnectionsWhen, closeServer } from './shutdown.ts'
import { createWorkerHealthApp } from './worker-health.ts'

/**
 * The /api/v1 route groups, each created with what it needs. The OpenAPI document (and with
 * it the web app's types, `npm run api:types`) is made from this same list. Route groups hold
 * only db, the notifier and in-memory rate limiters, and creating them touches none of them.
 */
export function productRoutes({
  db,
  socialProviders,
  notify,
  googleCalendar,
  microsoftCalendar,
  zoomConference,
  zoomWebhookSecretToken,
  zoomWebhookClientId,
  enqueueCalendarSync,
  enqueueCalendarWritebackRecovery,
  mcpAuth,
  publicUrl = 'http://localhost',
  webhooks = { enabled: false },
  automaticMeet = false,
  automaticZoom = false,
  bookingMaxInviteeReschedules,
  hostedSignupUrl,
  privacyPolicyUrl,
  termsUrl,
}: {
  db: Db
  automaticMeet?: boolean
  automaticZoom?: boolean
  bookingMaxInviteeReschedules?: number | undefined
  hostedSignupUrl?: string
  privacyPolicyUrl?: string
  termsUrl?: string
  webhooks?: import('@hourmere/webhooks').WebhookSettings
  mcpAuth?: Pick<ReturnType<typeof createAuth>, 'handler'> | undefined
  publicUrl?: string
  socialProviders: Config['socialProviders']
  /** Queues booking emails in the booking's transaction (the OpenAPI document needs none). */
  notify?: BookingNotifier | undefined
  googleCalendar?: CalendarDeps['google']
  microsoftCalendar?: CalendarDeps['microsoft']
  zoomConference?: ConferenceDeps['zoom']
  zoomWebhookSecretToken?: string | undefined
  zoomWebhookClientId?: string | undefined
  enqueueCalendarSync?: CalendarDeps['enqueueSync']
  enqueueCalendarWritebackRecovery?: CalendarDeps['enqueueWritebackRecovery']
}): RouteModule[] {
  return [
    mcpOAuthRoutes({ auth: mcpAuth, db, publicUrl }),
    instanceRoutes({
      socialProviders,
      automaticMeet,
      automaticZoom,
      hostedSignupUrl,
      privacyPolicyUrl,
      termsUrl,
    }),
    calendarRoutes({
      db,
      google: googleCalendar,
      microsoft: microsoftCalendar,
      enqueueSync: enqueueCalendarSync,
      enqueueWritebackRecovery: enqueueCalendarWritebackRecovery,
    }),
    conferenceRoutes({ db, zoom: zoomConference }),
    zoomEventRoutes({
      db,
      secretToken: zoomWebhookSecretToken,
      clientId: zoomWebhookClientId,
    }),
    profileRoutes({ db }),
    scheduleRoutes({ db }),
    webhookRoutes({ db, ...webhooks }),
    eventTypeRoutes({ db, automaticMeet, automaticZoom }),
    publicRoutes({ db, notify, automaticMeet, automaticZoom }),
    bookingRoutes({ db, notify, automaticMeet, automaticZoom, bookingMaxInviteeReschedules }),
    teamBookingRoutes({ db, notify }),
    memberDepartureImpactRoutes({ db }),
    memberLeaveRoutes({ db }),
    analyticsRoutes({ db }),
    readinessRoutes({ db, automaticMeet, automaticZoom }),
  ]
}

/** The same tool registry is used by the running server and capability contract tests. */
export function productTools({
  db,
  notify,
  automaticMeet,
  automaticZoom,
  bookingMaxInviteeReschedules,
  googleCalendar,
  zoomConference,
}: {
  db: Db
  notify?: BookingNotifier | undefined
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  bookingMaxInviteeReschedules?: number | undefined
  googleCalendar?: CalendarDeps['google']
  zoomConference?: ConferenceDeps['zoom']
}): Tool[] {
  return [
    whoamiTool,
    ...bookingTools({ db, notify, automaticMeet, automaticZoom, bookingMaxInviteeReschedules }),
    ...catalogTools({ db }),
    ...integrationTools({
      calendar: { db, google: googleCalendar },
      conference: { db, zoom: zoomConference },
    }),
  ]
}

export interface RunningServer {
  port: number
  /**
   * Stops accepting requests, stops the job workers (waiting for running jobs up to a
   * timeout), closes the database pools and restores the console.
   */
  close(): Promise<void>
}

/** Starts Hourmere from environment variables (see .env.example). */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  // First, before anything can log: one line per console call, control characters escaped.
  const restoreConsole = installOneLineConsole()
  try {
    return await start(env, restoreConsole)
  } catch (err) {
    restoreConsole()
    throw err
  }
}

async function start(env: NodeJS.ProcessEnv, restoreConsole: () => void): Promise<RunningServer> {
  const config = loadConfig(env)
  if (config.WEBHOOK_PRIVATE_TARGETS.length)
    console.warn(
      'WEBHOOK_PRIVATE_TARGETS permits operator-trusted private webhook destinations. Self-hosting only; Hourmere Cloud must never enable this setting.',
    )
  const pool = createPool(config.DATABASE_URL)
  const db = createDb(pool)

  if (config.AUTO_MIGRATE) {
    const applied = await runMigrations(pool)
    if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`)
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
    role === 'worker' ? undefined : createAuthPool(config.DATABASE_URL, config.signup)
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
  let enqueueConference: (id: string) => Promise<unknown> = async () => {}
  let enqueueCalendar: (calendarId: string) => Promise<unknown> = async () => {}
  let enqueueBookingCalendar: (id: string) => Promise<unknown> = async () => {}
  let enqueueWritebackRecovery: (connectionId: string, after?: string) => Promise<unknown> =
    async () => {}
  // Background jobs: every role queues them, `all` and `worker` run them.
  const notificationDeps = {
    db,
    mailer,
    publicUrl: config.PUBLIC_URL,
    secret: config.BETTER_AUTH_SECRET,
    mailRecipientMaxPerHour: config.MAIL_RECIPIENT_MAX_PER_HOUR,
    mailRecipientMaxPerDay: config.MAIL_RECIPIENT_MAX_PER_DAY,
    mailMaxPerHour: config.MAIL_MAX_PER_HOUR,
  }
  const invitationQueue: InvitationEmailQueue = {
    enqueue: (name, payload, options) => jobs.enqueue(name, payload, options),
    hasLiveInvitationEmailJob: (identity, transaction) =>
      jobs.hasLiveInvitationEmailJob(identity, transaction),
  }
  const invitationDeliveryDeps = { db, queue: invitationQueue }
  const repairInvitations = createInvitationEmailRepairer(invitationDeliveryDeps)
  const jobs = createJobs({
    connectionString: config.DATABASE_URL,
    definitions: [
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
      bookingNotificationJob(notificationDeps),
      conferenceNotificationDispatchJob(notificationDeps),
      notificationEmailCleanupJob(notificationDeps),
      invitationEmailJob({ db }),
      invitationEmailRepairJob(repairInvitations),
      bookingConferenceJob(calendarDeps),
      conferenceDispatchJob(calendarDeps, (id) => enqueueConference(id)),
      conferenceMirrorDispatchJob(calendarDeps, (id) => enqueueBookingCalendar(id)),
      webhookDeliveryJob({ db, ...webhookSettings }),
      webhookCleanupJob(db),
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
  enqueueBookingCalendar = (id) =>
    jobs.enqueue('booking-calendar', { bookingId: id }, { singletonKey: id })
  enqueueWritebackRecovery = (connectionId, after) =>
    jobs.enqueue(
      'booking-calendar-recover',
      { connectionId, ...(after ? { after } : {}) },
      { singletonKey: connectionId },
    )
  enqueueCalendar = (id) => jobs.enqueue('calendar-sync', { calendarId: id }, { singletonKey: id })
  enqueueConference = (id) =>
    jobs.enqueue('booking-conference', { rootBookingId: id }, { singletonKey: id })
  try {
    await jobs.start()
    if (role !== 'web') await repairInvitations()
  } catch (err) {
    try {
      await jobs.stop()
    } finally {
      await Promise.all([db.destroy(), authPool?.end()])
    }
    throw err
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
    const conferenceNotifier = conferenceBookingNotifier(jobs)
    const webhookNotifier = webhookBookingNotifier(jobs, webhookSettings)
    const notify: BookingNotifier = async (trx, event, now) => {
      await conferenceNotifier(trx, event)
      await emailNotifier(trx, event, now)
      if (googleCalendar) await calendarNotifier(trx, event)
      await webhookNotifier(trx, event, now)
    }
    const auth = createAuth({
      pool: authPool,
      db,
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
      baseURL: config.PUBLIC_URL,
      secret: config.BETTER_AUTH_SECRET,
      mailer: countingMailer,
      enqueueInvitationEmail: createInvitationEmailDispatcher(invitationDeliveryDeps),
      reserveInvitationEmail: (trx, input) =>
        reserveInvitationEmailBudget(trx, input, {
          ...notificationDeps,
          invitationInviterMaxPerHour: config.INVITATION_INVITER_MAX_PER_HOUR,
          invitationInviterMaxPerDay: config.INVITATION_INVITER_MAX_PER_DAY,
          invitationTeamMaxPerHour: config.INVITATION_TEAM_MAX_PER_HOUR,
          invitationTeamMaxPerDay: config.INVITATION_TEAM_MAX_PER_DAY,
        }),
      queueSignInEmail: queuedSignInEmail(jobs, {
        db,
        secret: config.BETTER_AUTH_SECRET,
        publicUrl: config.PUBLIC_URL,
      }),
      signup: config.signup,
      socialProviders: config.socialProviders,
      mcpOAuth: config.MCP_OAUTH_ENABLED,
    })
    fetch = createApp({
      checkDb,
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: config.PUBLIC_URL,
      embedOrigins: config.EMBED_ALLOWED_ORIGINS,
      hstsMaxAge: config.HSTS_MAX_AGE,
      trustedProxies: config.trustedProxies,
      webDist: config.WEB_DIST,
      // db is closed below.
      routes: productRoutes({
        mcpAuth: config.MCP_OAUTH_ENABLED ? auth : undefined,
        publicUrl: config.PUBLIC_URL,
        db,
        socialProviders: config.socialProviders,
        automaticMeet: config.GOOGLE_MEET_ENABLED,
        automaticZoom: config.ZOOM_MEETINGS_ENABLED,
        bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
        hostedSignupUrl: config.HOSTED_SIGNUP_URL,
        privacyPolicyUrl: config.PRIVACY_POLICY_URL,
        termsUrl: config.TERMS_URL,
        webhooks: webhookSettings,
        notify,
        googleCalendar,
        microsoftCalendar,
        zoomConference,
        zoomWebhookSecretToken: config.ZOOM_WEBHOOK_SECRET_TOKEN,
        zoomWebhookClientId: config.ZOOM_CLIENT_ID,
        enqueueCalendarSync: (id, trx) =>
          jobs.enqueue('calendar-sync', { calendarId: id }, { singletonKey: id, transaction: trx }),
        enqueueCalendarWritebackRecovery: (connectionId, trx) =>
          jobs.enqueue(
            'booking-calendar-recover',
            { connectionId },
            { singletonKey: connectionId, transaction: trx },
          ),
      }),
      mcp: mcpEndpoint({
        ...(config.MCP_OAUTH_ENABLED
          ? {
              oauth: {
                resolve: createMcpOAuthResolver({ auth, db, publicUrl: config.PUBLIC_URL }),
                handler: auth.handler,
              },
            }
          : {}),
        tools: productTools({
          db,
          notify,
          automaticMeet: config.GOOGLE_MEET_ENABLED,
          automaticZoom: config.ZOOM_MEETINGS_ENABLED,
          bookingMaxInviteeReschedules: config.BOOKING_MAX_INVITEE_RESCHEDULES,
          googleCalendar,
          zoomConference,
        }),
      }),
    }).fetch
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
