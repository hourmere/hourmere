const { version: platformVersion } = require('zapier-platform-core')
const { version } = require('./package.json')
const { baseUrl, request, publicPath } = require('./lib.js')
const hooks = require('./hooks.js')

const field = (key, label, required = true, extra = {}) => ({ key, label, required, ...extra })
const eventFields = [
  field('kind', 'Booking page kind', true, { choices: ['personal', 'team'], default: 'personal' }),
  field('handle', 'Host handle or team slug'),
  field('slug', 'Event type slug', true, {
    dynamic: 'event_types.slug.title',
    helpText:
      'The dropdown lists event types in the key’s organization. Enter another public event slug manually if needed.',
  }),
]
const duration = field('durationMinutes', 'Meeting length (minutes)', false, { type: 'integer' })
const start = field('start', 'Start time', true, { type: 'datetime' })
const bookingSample = {
  id: '00000000-0000-4000-8000-000000000001',
  start: '2026-12-02T10:00:00Z',
  end: '2026-12-02T10:30:00Z',
  status: 'confirmed',
  title: 'Intro call',
}
const bookingOutput = [
  { key: 'id', label: 'Booking ID' },
  { key: 'start' },
  { key: 'end' },
  { key: 'status' },
  { key: 'title' },
]
const listEventTypes = async (z, bundle) => (await request(z, bundle, '/event-types')).data

module.exports = {
  version,
  platformVersion,
  authentication: {
    type: 'custom',
    fields: [
      field('baseUrl', 'Hourmere HTTPS origin', true, {
        helpText: 'For example https://hourmere.example.com. Hourmere Cloud is not available yet.',
      }),
      field('apiKey', 'API key', true, {
        type: 'password',
        helpText:
          'Use read for reads, bookings for booking actions, or full with owner/admin permission for webhook triggers.',
      }),
    ],
    test: async (z, bundle) => {
      await request(z, bundle, '/me')
      return { baseUrl: baseUrl(z, bundle) }
    },
    connectionLabel: '{{bundle.authData.baseUrl}}',
  },
  triggers: {
    ...hooks,
    event_types: {
      key: 'event_types',
      noun: 'Event Type',
      display: {
        label: 'List Event Types',
        description: 'Lists event types in the connected organization.',
        hidden: true,
      },
      operation: {
        perform: listEventTypes,
        sample: { id: '00000000-0000-4000-8000-000000000002', slug: 'intro', title: 'Intro call' },
        outputFields: [{ key: 'id' }, { key: 'slug' }, { key: 'title' }],
      },
    },
  },
  creates: {
    create_booking: {
      key: 'create_booking',
      noun: 'Booking',
      display: {
        label: 'Create Booking',
        description: 'Books an available personal or team slot using a retained idempotency key.',
      },
      operation: {
        inputFields: [
          ...eventFields,
          start,
          duration,
          field('name', 'Invitee name'),
          field('email', 'Invitee email'),
          field('timeZone', 'Invitee IANA time zone'),
          field('locale', 'Invitee locale', false),
          field('idempotencyKey', 'Idempotency key', true, {
            helpText:
              'Map a random UUID saved by the source workflow. Reuse for retries of the same booking; never generate a new value on retry.',
          }),
          field('responses', 'Question answers (JSON object)', false),
        ],
        perform: async (z, bundle) => {
          const input = bundle.inputData
          if (!input.idempotencyKey || !/^[\x20-\x7e]{1,255}$/.test(input.idempotencyKey))
            throw new z.errors.Error(
              'Provide a retained random idempotency key (1–255 printable ASCII characters).',
              'invalid_idempotency_key',
            )
          let responses
          if (input.responses) {
            try {
              responses = JSON.parse(input.responses)
            } catch {
              throw new z.errors.Error(
                'Question answers must be a JSON object.',
                'invalid_responses',
              )
            }
            if (!responses || typeof responses !== 'object' || Array.isArray(responses))
              throw new z.errors.Error(
                'Question answers must be a JSON object.',
                'invalid_responses',
              )
          }
          const result = await request(z, bundle, `${publicPath(bundle)}/bookings`, {
            method: 'POST',
            headers: { 'Idempotency-Key': input.idempotencyKey },
            body: {
              start: input.start,
              ...(input.durationMinutes !== undefined
                ? { durationMinutes: input.durationMinutes }
                : {}),
              invitee: {
                name: input.name,
                email: input.email,
                timeZone: input.timeZone,
                ...(input.locale ? { locale: input.locale } : {}),
              },
              ...(responses ? { responses } : {}),
            },
          })
          return result.booking
        },
        sample: bookingSample,
        outputFields: bookingOutput,
      },
    },
    cancel_booking: {
      key: 'cancel_booking',
      noun: 'Booking',
      display: {
        label: 'Cancel Booking',
        description: 'Cancels a booking that the API key owner hosts.',
      },
      operation: {
        inputFields: [field('id', 'Booking ID'), field('reason', 'Cancellation reason', false)],
        perform: async (z, bundle) => {
          const result = await request(
            z,
            bundle,
            `/bookings/${encodeURIComponent(bundle.inputData.id)}/cancel`,
            {
              method: 'POST',
              body: bundle.inputData.reason ? { reason: bundle.inputData.reason } : {},
            },
          )
          return result
        },
        sample: { ...bookingSample, status: 'cancelled' },
        outputFields: bookingOutput,
      },
    },
    reschedule_booking: {
      key: 'reschedule_booking',
      noun: 'Booking',
      display: {
        label: 'Reschedule Booking',
        description: 'Moves a booking that the API key owner hosts and returns its successor.',
      },
      operation: {
        inputFields: [field('id', 'Booking ID'), start, duration],
        perform: async (z, bundle) =>
          (
            await request(
              z,
              bundle,
              `/bookings/${encodeURIComponent(bundle.inputData.id)}/reschedule`,
              {
                method: 'POST',
                body: {
                  start: bundle.inputData.start,
                  ...(bundle.inputData.durationMinutes !== undefined
                    ? { durationMinutes: bundle.inputData.durationMinutes }
                    : {}),
                },
              },
            )
          ).booking,
        sample: bookingSample,
        outputFields: bookingOutput,
      },
    },
  },
  searches: {
    find_booking: {
      key: 'find_booking',
      noun: 'Booking',
      display: {
        label: 'Find Booking',
        description: 'Finds a booking by ID among bookings the API key owner hosts.',
      },
      operation: {
        inputFields: [field('id', 'Booking ID')],
        perform: async (z, bundle) => {
          const result = await request(
            z,
            bundle,
            `/bookings/${encodeURIComponent(bundle.inputData.id)}`,
            { allowNotFound: true },
          )
          return result ? [result] : []
        },
        sample: bookingSample,
        outputFields: bookingOutput,
      },
    },
    find_available_slots: {
      key: 'find_available_slots',
      noun: 'Slot',
      display: {
        label: 'Find Available Slots',
        description:
          'Finds offered slots in a time range of at most 62 days. Does not reserve a slot.',
      },
      operation: {
        inputFields: [
          ...eventFields,
          start,
          field('end', 'Range end', true, { type: 'datetime' }),
          duration,
        ],
        perform: async (z, bundle) => {
          const { start, end, durationMinutes } = bundle.inputData
          const result = await request(z, bundle, `${publicPath(bundle)}/slots`, {
            params: { start, end, ...(durationMinutes !== undefined ? { durationMinutes } : {}) },
          })
          return result.data.map((slot) => ({ id: slot.start, ...slot }))
        },
        sample: { id: bookingSample.start, start: bookingSample.start, end: bookingSample.end },
        outputFields: [{ key: 'id' }, { key: 'start' }, { key: 'end' }],
      },
    },
  },
}
