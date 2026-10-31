import '../../i18n/admin.ts'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { emptyDraft } from './event-type-form.ts'
import { ZoomMeetingFields } from './ZoomMeetingFields.tsx'

describe('automatic Zoom mode guidance', () => {
  it.each(['collective', 'round_robin'] as const)(
    'does not suggest a %s host can enable automatic Zoom from their session',
    (schedulingType) => {
      render(
        <InterfaceScope surface="admin">
          <ZoomMeetingFields
            draft={{ ...emptyDraft(), locationKind: 'zoom', schedulingType }}
            errors={{}}
            enabled
            userId="current-host"
            personal={false}
            session
            set={() => {}}
          />
        </InterfaceScope>,
      )
      expect(
        screen.getByText('Automatic Zoom supports individual meetings with exactly one host.'),
      ).toBeDefined()
      expect(
        screen.queryByText('The assigned host must configure Zoom in their own signed-in session.'),
      ).toBeNull()
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', {
          name: 'Create a unique Zoom meeting for each booking',
        }).disabled,
      ).toBe(true)
    },
  )
})
