import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../openapi-document.ts'
import { Profile } from '../routes/profile.ts'
import { CreateBooking } from '../routes/public.ts'

describe('locale protocol contract', () => {
  it('documents the registry and English fallback without restricting BCP 47 preferences', async () => {
    const document = JSON.stringify(await openApiDocument())
    for (const { code } of registeredLocales) expect(document).toContain(code)
    expect(document).toContain(
      'unsupported languages and missing translations fall back to English',
    )
    // MCP reuses these REST schemas; the CLI forwards these same arguments unchanged.
    const invitee = {
      name: 'Fixture',
      email: 'fixture@example.test',
      timeZone: 'UTC',
      locale: 'pt-BR',
    }
    expect(CreateBooking.parse({ start: '2026-11-02T09:00:00Z', invitee }).invitee.locale).toBe(
      'pt-BR',
    )
    expect(Profile.shape.locale.parse('pt-BR')).toBe('pt-BR')
    expect(
      CreateBooking.safeParse({
        start: '2026-11-02T09:00:00Z',
        invitee: { ...invitee, locale: 42 },
      }).success,
    ).toBe(false)
  })
})
