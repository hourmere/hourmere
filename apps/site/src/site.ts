// Facts shown across the site. Keep them in one place so pages stay consistent.

import { siteCopy } from './ui-copy.ts'

export const site = {
  name: 'Hourmere',
  url: 'https://hourmere.com',
  tagline: 'Open-source scheduling for people and AI agents.',
  description:
    'Open-source scheduling software, an alternative to Calendly: share a booking link, let invitees pick a time, and let AI assistants book through an API and a remote MCP server. Hourmere Cloud is in an invitation-only preview at app.hourmere.com.',
  github: 'https://github.com/hourmere/hourmere',
  socialImage: {
    url: 'https://hourmere.com/og-image.png',
    width: 1200,
    height: 630,
    alt: siteCopy.en.socialImageAlt,
  },
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

export const googlePolicies = {
  userData: 'https://developers.google.com/terms/api-services-user-data-policy',
  workspace: 'https://developers.google.com/workspace/workspace-api-user-data-developer-policy',
  connections: 'https://myaccount.google.com/connections',
} as const
