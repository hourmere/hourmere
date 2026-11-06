import {
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeProperties,
  type INodeType,
  type INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow'
import { hourmereRequest } from '../../shared/http'

const field = (
  name: string,
  displayName: string,
  operations: string[],
  required = true,
): INodeProperties => ({
  name,
  displayName,
  type: 'string',
  default: '',
  required,
  displayOptions: { show: { operation: operations } },
})
const operations = [
  ['listEventTypes', 'List Event Types'],
  ['findSlots', 'Find Available Slots'],
  ['createBooking', 'Create Booking'],
  ['getBooking', 'Get Booking'],
  ['cancelBooking', 'Cancel Booking'],
  ['rescheduleBooking', 'Reschedule Booking'],
  ['listBookings', 'List Bookings'],
]
export class Hourmere implements INodeType {
  description: INodeTypeDescription = {
    icon: { light: 'file:hourmere.svg', dark: 'file:hourmere.dark.svg' },
    displayName: 'Hourmere',
    name: 'hourmere',
    subtitle: '={{$parameter.operation}}',
    usableAsTool: true,
    group: ['transform'],
    version: 1,
    description: 'Read availability and manage Hourmere bookings',
    defaults: { name: 'Hourmere' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'hourmereApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'listEventTypes',
        options: operations.map(([value, name]) => ({ name: name!, value: value!, action: name! })),
      },
      {
        displayName: 'Event Page',
        name: 'pageType',
        type: 'options',
        default: 'personal',
        options: [
          { name: 'Personal', value: 'personal' },
          { name: 'Team', value: 'team' },
        ],
        displayOptions: { show: { operation: ['findSlots', 'createBooking'] } },
      },
      field('handle', 'Handle / Team Slug', ['findSlots', 'createBooking']),
      field('slug', 'Event Type Slug', ['findSlots', 'createBooking']),
      {
        ...field('start', 'Start', ['findSlots', 'createBooking', 'rescheduleBooking']),
        description: 'RFC 3339 instant with Z or an explicit UTC offset',
      },
      field('end', 'Range End', ['findSlots']),
      {
        ...field('timeZone', 'Time Zone', ['findSlots', 'createBooking']),
        default: 'UTC',
        description:
          'IANA time zone, for example America/Los_Angeles; slot instants retain their UTC values',
      },
      field('name', 'Invitee Name', ['createBooking']),
      field('email', 'Invitee Email', ['createBooking']),
      {
        ...field('idempotencyKey', 'Idempotency Key', ['createBooking']),
        description: 'Retain the same unique key and identical inputs when retrying this booking',
      },
      field('bookingId', 'Booking ID', ['getBooking', 'cancelBooking', 'rescheduleBooking']),
      field('reason', 'Cancellation Reason', ['cancelBooking'], false),
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        displayOptions: {
          show: { operation: ['findSlots', 'createBooking', 'rescheduleBooking'] },
        },
        options: [
          {
            displayName: 'Duration (Minutes)',
            name: 'durationMinutes',
            type: 'number',
            default: 30,
            typeOptions: { minValue: 1, maxValue: 1440 },
          },
          {
            displayName: 'Responses (JSON)',
            name: 'responses',
            type: 'json',
            default: '{}',
            description: 'Answers keyed by question ID; used only for booking creation',
          },
          {
            displayName: 'Guests (JSON)',
            name: 'guests',
            type: 'json',
            default: '[]',
            description: 'Array of name and email objects; used only for booking creation',
          },
        ],
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        placeholder: 'Add Filter',
        default: {},
        displayOptions: { show: { operation: ['listBookings'] } },
        options: [
          ...['from', 'to', 'endAfter', 'endTo', 'cursor'].map((name) => ({
            displayName: (
              {
                from: 'Start From',
                to: 'Start Before',
                endAfter: 'End After',
                endTo: 'End At or Before',
                cursor: 'Cursor',
              } as Record<string, string>
            )[name]!,
            name,
            type: 'string' as const,
            default: '',
          })),
          {
            displayName: 'Status',
            name: 'status',
            type: 'options',
            default: 'confirmed',
            options: [
              { name: 'Confirmed', value: 'confirmed' },
              { name: 'Cancelled', value: 'cancelled' },
            ],
          },
          {
            displayName: 'Order',
            name: 'order',
            type: 'options',
            default: 'asc',
            options: [
              { name: 'Ascending', value: 'asc' },
              { name: 'Descending', value: 'desc' },
            ],
          },
          {
            displayName: 'Limit',
            description: 'Max number of results to return',
            name: 'limit',
            type: 'number',
            default: 50,
            typeOptions: { minValue: 1, maxValue: 100 },
          },
        ],
      },
    ],
  }
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const output: INodeExecutionData[] = []
    for (let i = 0; i < this.getInputData().length; i++) {
      try {
        const get = (name: string, fallback: unknown = '') =>
          this.getNodeParameter(name, i, fallback)
        const text = (name: string) => String(get(name))
        const operation = text('operation')
        const extra = get('additionalFields', {}) as IDataObject
        const duration =
          extra.durationMinutes === undefined ? {} : { durationMinutes: extra.durationMinutes }
        const id = encodeURIComponent(text('bookingId'))
        let result: IDataObject
        if (operation === 'listEventTypes')
          result = await hourmereRequest.call(this, 'GET', '/event-types')
        else if (operation === 'listBookings')
          result = await hourmereRequest.call(
            this,
            'GET',
            '/bookings',
            undefined,
            get('filters', {}) as IDataObject,
          )
        else if (operation === 'getBooking')
          result = await hourmereRequest.call(this, 'GET', `/bookings/${id}`)
        else if (operation === 'cancelBooking')
          result = await hourmereRequest.call(this, 'POST', `/bookings/${id}/cancel`, {
            reason: text('reason'),
          })
        else if (operation === 'rescheduleBooking')
          result = await hourmereRequest.call(this, 'POST', `/bookings/${id}/reschedule`, {
            start: text('start'),
            ...duration,
          })
        else if (operation === 'findSlots' || operation === 'createBooking') {
          const timeZone = text('timeZone')
          let format: Intl.DateTimeFormat
          try {
            format = new Intl.DateTimeFormat('en-CA', {
              timeZone,
              dateStyle: 'short',
              timeStyle: 'long',
            })
          } catch {
            throw new NodeOperationError(this.getNode(), 'Enter a valid IANA time zone')
          }
          const path = `/public${text('pageType') === 'team' ? '/teams' : ''}/${encodeURIComponent(text('handle'))}/${encodeURIComponent(text('slug'))}`
          if (operation === 'findSlots') {
            result = await hourmereRequest.call(this, 'GET', `${path}/slots`, undefined, {
              start: text('start'),
              end: text('end'),
              ...duration,
            })
            result = {
              ...result,
              timeZone,
              data: (result.data as IDataObject[]).map((slot) => ({
                ...slot,
                localStart: format.format(new Date(String(slot.start))),
                localEnd: format.format(new Date(String(slot.end))),
              })),
            }
          } else {
            const key = text('idempotencyKey').trim()
            if (!key)
              throw new NodeOperationError(
                this.getNode(),
                'An idempotency key is required for booking creation',
              )
            const body: IDataObject = {
              start: text('start'),
              ...duration,
              invitee: { name: text('name'), email: text('email'), timeZone },
            }
            for (const field of ['responses', 'guests'])
              if (extra[field] !== undefined)
                body[field] =
                  typeof extra[field] === 'string'
                    ? JSON.parse(extra[field] as string)
                    : extra[field]
            result = await hourmereRequest.call(this, 'POST', `${path}/bookings`, body, undefined, {
              'Idempotency-Key': key,
            })
          }
        } else throw new NodeOperationError(this.getNode(), 'Unknown Hourmere operation')
        output.push({ json: result, pairedItem: { item: i } })
      } catch (error) {
        const safe =
          error instanceof NodeOperationError
            ? error
            : new NodeOperationError(this.getNode(), 'Invalid Hourmere node parameters')
        if (!this.continueOnFail()) throw safe
        output.push({ json: { error: safe.message }, pairedItem: { item: i } })
      }
    }
    return [output]
  }
}
