import type { Db } from '@hourmere/db'
import { createSmsService, smsRetentionJob } from '@hourmere/notifications/sms'
import { createTwilioSmsProvider } from '@hourmere/notifications/sms-provider'
import type { Config } from './config.ts'

/** Internal factory only: configuration does not register jobs or public routes. */
export function createConfiguredSmsService(config: Config, db: Db) {
  return createSmsService({
    db,
    hashSecret: config.SMS_HASH_KEY ?? '',
    provider:
      config.SMS_PROVIDER === 'twilio'
        ? createTwilioSmsProvider({
            accountSid: config.TWILIO_ACCOUNT_SID ?? '',
            authToken: config.TWILIO_AUTH_TOKEN,
            apiKeySid: config.TWILIO_API_KEY_SID,
            apiKeySecret: config.TWILIO_API_KEY_SECRET,
            messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
            from: config.TWILIO_FROM,
          })
        : undefined,
    limits: {
      recipientPerHour: config.SMS_RECIPIENT_MAX_PER_HOUR,
      recipientPerDay: config.SMS_RECIPIENT_MAX_PER_DAY,
      instancePerHour: config.SMS_MAX_PER_HOUR,
      organizationPerDay: config.SMS_ORGANIZATION_MAX_PER_DAY,
    },
  })
}

/** Metadata cleanup remains active when sending is disabled. Never schedules sending. */
export function configuredSmsJobs(_config: Config, db: Db) {
  return [smsRetentionJob({ db })]
}
