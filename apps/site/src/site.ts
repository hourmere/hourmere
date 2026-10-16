// Facts shown across the site. Keep them in one place so pages stay consistent.

export const site = {
  name: 'Hourmere',
  url: 'https://hourmere.com',
  tagline: 'Open-source scheduling for people and AI agents.',
  description:
    'Hourmere is open-source scheduling software in development, an alternative to Calendly. Share a booking link, let invitees pick a time that works, and let your AI assistant book meetings through an API and a remote MCP server.',
  github: 'https://github.com/cobaltmere',
  license: { name: 'AGPL-3.0', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
} as const

export const company = {
  name: 'Cobaltmere, LLC',
  shortName: 'Cobaltmere',
  url: 'https://cobaltmere.com',
  terms: 'https://cobaltmere.com/terms',
  privacyPolicy: 'https://cobaltmere.com/privacy',
  refundPolicy: 'https://cobaltmere.com/refund',
} as const

export const contact = {
  hello: 'hello@hourmere.com',
  support: 'support@hourmere.com',
  security: 'security@hourmere.com',
  privacy: 'privacy@cobaltmere.com',
} as const

export const launchUpdatesHref = `mailto:${contact.hello}?subject=${encodeURIComponent('Hourmere launch updates')}`

export const googlePolicies = {
  userData: 'https://developers.google.com/terms/api-services-user-data-policy',
  workspace: 'https://developers.google.com/workspace/workspace-api-user-data-developer-policy',
  connections: 'https://myaccount.google.com/connections',
} as const
