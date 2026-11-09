import {
  type IDataObject,
  type IHookFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow'
import { HourmereApiError, hourmereRequest, testHourmereCredential } from '../../shared/http'
import { claimEvent, EVENTS, verifiedEvent } from './signature'

function clearRegistration(data: IDataObject) {
  claimEvent.clear(data)
  delete data.webhookId
  delete data.webhookSecret
  delete data.receipts
}

async function removeRegistration(context: IHookFunctions, data: IDataObject) {
  if (typeof data.webhookId === 'string') {
    try {
      await hourmereRequest.call(
        context,
        'DELETE',
        `/webhooks/${encodeURIComponent(data.webhookId)}`,
      )
    } catch (error) {
      // A manually removed remote webhook is already deactivated; other failures must be visible.
      if (
        !(
          error &&
          typeof error === 'object' &&
          'httpCode' in error &&
          String(error.httpCode) === '404'
        )
      )
        throw new NodeOperationError(
          context.getNode(),
          error instanceof HourmereApiError
            ? error.message
            : 'Hourmere webhook deletion failed. Check credentials and connectivity.',
        )
    }
  }
  clearRegistration(data)
}

function normalizedWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).href
  } catch {
    return undefined
  }
}

export class HourmereTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Hourmere Trigger',
    name: 'hourmereTrigger',
    icon: { light: 'file:hourmere.svg', dark: 'file:hourmere.dark.svg' },
    group: ['trigger'],
    version: 1,
    description: 'Receive signed Hourmere booking events',
    subtitle: '={{$parameter["events"].join(", ")}}',
    defaults: { name: 'Hourmere Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'hourmereApi', required: true, testedBy: 'testHourmereCredential' }],
    webhooks: [
      { name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
    ],
    properties: [
      {
        displayName:
          'Requires a Full API key and organization owner/admin access. Protect workflow static data: it contains the webhook signing secret. Use event IDs to deduplicate downstream side effects.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        options: [
          { name: 'Attendee No-Show Changed', value: 'booking.attendee_no_show_changed' },
          { name: 'Booking Cancelled', value: 'booking.cancelled' },
          { name: 'Booking Created', value: 'booking.created' },
          {
            name: 'Booking Reschedule Request Expired',
            value: 'booking.reschedule_request_expired',
          },
          { name: 'Booking Reschedule Requested', value: 'booking.reschedule_requested' },
          { name: 'Booking Rescheduled', value: 'booking.rescheduled' },
        ],
        default: ['booking.created'],
        description: 'Events that start the workflow',
      },
    ],
  }

  methods = { credentialTest: { testHourmereCredential } }

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node')
        if (typeof data.webhookId !== 'string' || typeof data.webhookSecret !== 'string')
          return false
        const webhooks = await hourmereRequest.call(this, 'GET', '/webhooks')
        const found = (webhooks as unknown as IDataObject[]).find(
          (webhook) => webhook.id === data.webhookId,
        )
        if (!found) {
          clearRegistration(data)
          return false
        }
        const events = this.getNodeParameter('events') as string[]
        return (
          found.isActive === true &&
          normalizedWebhookUrl(found.url) !== undefined &&
          normalizedWebhookUrl(found.url) ===
            normalizedWebhookUrl(this.getNodeWebhookUrl('default')) &&
          Array.isArray(found.events) &&
          found.events.length === events.length &&
          events.every((event) => (found.events as string[]).includes(event))
        )
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node')
        const events = this.getNodeParameter('events') as string[]
        const url = this.getNodeWebhookUrl('default')
        if (
          !url ||
          !events.length ||
          new Set(events).size !== events.length ||
          events.some((event) => !(EVENTS as readonly string[]).includes(event))
        ) {
          throw new NodeOperationError(
            this.getNode(),
            'Select at least one supported Hourmere event and configure the n8n webhook URL.',
          )
        }
        await removeRegistration(this, data)
        const response = await hourmereRequest.call(this, 'POST', '/webhooks', {
          url,
          events,
          isActive: true,
        })
        const webhook = response.webhook as IDataObject | undefined
        if (
          typeof webhook?.id !== 'string' ||
          typeof response.secret !== 'string' ||
          !response.secret
        ) {
          throw new NodeOperationError(
            this.getNode(),
            'Hourmere returned an invalid webhook registration response.',
          )
        }
        data.webhookId = webhook.id
        data.webhookSecret = response.secret
        data.receipts = {}
        return true
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node')
        try {
          await removeRegistration(this, data)
          return true
        } catch {
          // Keep the endpoint, secret and replay receipts together until remote removal succeeds.
          this.logger.warn(
            'Hourmere webhook deletion failed. Remove the endpoint in Hourmere webhook settings.',
          )
          return false
        }
      },
    },
  }

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const request = this.getRequestObject()
    // n8n retains the exact buffer through readRawBody(); never reserialize getBodyData().
    await request.readRawBody()
    const data = this.getWorkflowStaticData('node')
    const raw = request.rawBody
    const event = Buffer.isBuffer(raw)
      ? verifiedEvent(
          raw,
          request.headers['webhook-timestamp'],
          request.headers['webhook-signature'],
          data.webhookSecret,
        )
      : undefined
    if (!event) {
      this.getResponseObject().status(401).send('Invalid Hourmere webhook signature or payload')
      return { noWebhookResponse: true }
    }
    if (!(this.getNodeParameter('events') as string[]).includes(event.type as string)) return {}
    const claim = claimEvent(data, event.id as string)
    if (claim === 'full') {
      this.getResponseObject().status(503).send('Hourmere replay receipt capacity reached')
      return { noWebhookResponse: true }
    }
    if (claim === 'duplicate') return {}
    return { workflowData: [this.helpers.returnJsonArray(event)] }
  }
}
