import { brandColorContrast, brandPalette } from '@hourmere/core/brand-contrast'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PATHS } from '../paths.ts'
import {
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const BRAND = {
  brandLogo: null,
  brandPrimaryColor: '#777777',
  buttonTextColor: '#000000',
  backgroundContrast: 4.478,
  buttonTextContrast: 4.689,
}
const READ = 'GET /api/v1/branding'
const WRITE = 'PATCH /api/v1/branding'
const UPLOAD = 'POST /api/v1/branding/logo'

async function open() {
  renderApp(PATHS.settings)
  await userEvent.click(await screen.findByRole('button', { name: 'Manage branding' }))
  return screen.findByRole('form', { name: 'Edit branding' })
}

describe('branding settings', () => {
  it('previews unsaved colours with readable light and dark booking samples', async () => {
    const api = fakeApi({ ...signedInAs(ME), ...profile(), [READ]: () => json(200, BRAND) })
    const form = await open()
    expect(
      within(form).getByText(/Contrast against white \(#FFFFFF\) is reported separately\./),
    ).toBeDefined()
    for (const colour of ['#777777', '#FFFF00', '#000000']) {
      fireEvent.change(within(form).getByLabelText('Primary colour'), { target: { value: colour } })
      const palette = brandPalette(colour)
      if (!palette) throw new Error('Expected a valid palette')
      for (const mode of ['light', 'dark'] as const) {
        const region = within(form).getByRole('region', {
          name: mode === 'light' ? 'Light preview' : 'Dark preview',
        })
        const theme = palette[mode]
        expect(region.getAttribute('data-brand-preview')).toBe(mode)
        expect(within(region).getByText('Sample introduction call')).toBeDefined()
        expect(within(region).getByText(`Displayed accent: ${theme.accent}`)).toBeDefined()
        expect(
          within(region).getByText(
            `Button text contrast: ${brandColorContrast(theme.accent, theme.accentText).toFixed(2)}:1 (minimum 4.5:1).`,
          ),
        ).toBeDefined()
        expect(brandColorContrast(theme.accent, theme.accentText)).toBeGreaterThanOrEqual(4.5)
        expect(
          brandColorContrast(theme.link, mode === 'light' ? '#FFFFFF' : '#0E1015'),
        ).toBeGreaterThanOrEqual(4.5)
        expect(within(region).getByText('Confirm booking').style.background).not.toBe('')
      }
    }
    expect(api.to(WRITE)).toHaveLength(0)
    await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(within(form).getByRole('region', { name: '浅色预览' })).toBeDefined()
    expect(within(form).getByRole('region', { name: '深色预览' })).toBeDefined()
    expect(within(form).getByText(/与白色（#FFFFFF）的对比度会单独显示。/)).toBeDefined()
    expect(within(form).getByText(/最长边不超过 512 像素/)).toBeDefined()
  })

  it('previews a selected logo in both themes before upload and removes it locally', async () => {
    const api = fakeApi({ ...signedInAs(ME), ...profile(), [READ]: () => json(200, BRAND) })
    const form = await open()
    fireEvent.change(within(form).getByLabelText('Brand logo'), {
      target: { files: [new File(['sample'], 'logo.png', { type: 'image/png' })] },
    })
    for (const name of ['Light preview', 'Dark preview']) {
      const region = within(form).getByRole('region', { name })
      await waitFor(() =>
        expect(region.querySelector('img')?.getAttribute('src')).toBe(
          'data:image/png;base64,c2FtcGxl',
        ),
      )
    }
    expect(api.to(UPLOAD)).toHaveLength(0)
    await userEvent.click(within(form).getByRole('button', { name: 'Remove logo' }))
    await waitFor(() => expect(form.querySelectorAll('[data-brand-preview] img')).toHaveLength(0))
    expect(api.to(UPLOAD)).toHaveLength(0)
    expect(api.to(WRITE)).toHaveLength(0)
  })

  it('stages reset to defaults and only clears persisted settings on save', async () => {
    const hash = 'c'.repeat(64)
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [READ]: () => json(200, { ...BRAND, brandLogo: hash }),
      [`GET /api/v1/branding/logo/${hash}`]: () => new Response(new Uint8Array([1, 2, 3])),
      [WRITE]: ({ body }) => json(200, { ...BRAND, ...(body as object) }),
    })
    const form = await open()
    await within(form).findByAltText('Saved brand logo')
    await userEvent.click(within(form).getByRole('button', { name: 'Reset to default' }))
    expect((within(form).getByLabelText('Primary colour') as HTMLInputElement).value).toBe('')
    await waitFor(() => expect(within(form).queryByAltText('Saved brand logo')).toBeNull())
    expect(within(form).getByText('Displayed accent: #1F4FD8')).toBeDefined()
    expect(within(form).getByText('Displayed accent: #3D68E6')).toBeDefined()
    expect(api.to(WRITE)).toHaveLength(0)
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    await within(form).findByText('Branding saved.')
    expect(api.to(WRITE)[0]?.body).toEqual({ brandLogo: null, brandPrimaryColor: null })
  })

  it('saves colour with the opening space and displays readable text choice and informational contrast', async () => {
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [READ]: () => json(200, BRAND),
      [WRITE]: ({ body }) => json(200, { ...BRAND, ...(body as object) }),
    })
    const form = await open()
    expect(
      within(form).getByText(
        'Saved colour: #777777. Button text: Black. Contrast against white: 4.48:1.',
      ),
    ).toBeDefined()
    const colour = within(form).getByLabelText('Primary colour')
    fireEvent.change(colour, { target: { value: '#123456' } })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    expect(await within(form).findByText('Branding saved.')).toBeDefined()
    expect(api.to(WRITE)[0]?.body).toEqual({ brandPrimaryColor: '#123456' })
    for (const route of [READ, WRITE])
      expect(api.to(route)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
  })

  it('rejects malformed colour and oversized or forbidden files before sending writes', async () => {
    const api = fakeApi({ ...signedInAs(ME), ...profile(), [READ]: () => json(200, BRAND) })
    const form = await open()
    fireEvent.change(within(form).getByLabelText('Primary colour'), { target: { value: 'red' } })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    expect(within(form).getByRole('alert').textContent).toContain('#RRGGBB')
    fireEvent.change(within(form).getByLabelText('Primary colour'), {
      target: { value: '#abcdef' },
    })
    for (const file of [
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
      new File([new Uint8Array(512 * 1024 + 1)], 'logo.png', { type: 'image/png' }),
      new File([], 'empty.png', { type: 'image/png' }),
    ]) {
      fireEvent.change(within(form).getByLabelText('Brand logo'), { target: { files: [file] } })
      await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
      expect(within(form).getByRole('alert').textContent).toContain('up to 512 KiB')
    }
    expect(api.to(WRITE)).toHaveLength(0)
    expect(api.to(UPLOAD)).toHaveLength(0)
  })

  it('uploads a logo and supports clearing both settings', async () => {
    const hash = 'a'.repeat(64)
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [READ]: () => json(200, BRAND),
      [UPLOAD]: () => json(200, { ...BRAND, brandLogo: hash }),
      [`GET /api/v1/branding/logo/${hash}`]: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
      [WRITE]: ({ body }) => json(200, { ...BRAND, ...(body as object) }),
    })
    const form = await open()
    // The fetch fake parses bodies as JSON; a JSON payload with an image MIME type exercises the client transport. The server tests decode real images.
    fireEvent.change(within(form).getByLabelText('Brand logo'), {
      target: { files: [new File(['{}'], 'logo.png', { type: 'image/png' })] },
    })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    await within(form).findByText('Branding saved.')
    expect(api.to(UPLOAD)[0]?.headers.get('content-type')).toBe('image/png')
    expect(api.to(UPLOAD)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(api.to(WRITE)).toHaveLength(0)
    expect(await within(form).findByAltText('Saved brand logo')).toBeDefined()
    expect(
      api.to(`GET /api/v1/branding/logo/${hash}`)[0]?.headers.get('X-Expected-Organization-Id'),
    ).toBe(ME.organization.id)
    await userEvent.click(within(form).getByRole('button', { name: 'Remove logo' }))
    fireEvent.change(within(form).getByLabelText('Primary colour'), { target: { value: '' } })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    await waitFor(() => expect(api.to(WRITE)).toHaveLength(1))
    expect(api.to(WRITE)[0]?.body).toEqual({ brandLogo: null, brandPrimaryColor: null })
  })

  it('retains a committed upload when colour saving fails and retries only the colour', async () => {
    const hash = 'b'.repeat(64)
    let attempts = 0
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [READ]: () => json(200, BRAND),
      [UPLOAD]: () => json(200, { ...BRAND, brandLogo: hash }),
      [`GET /api/v1/branding/logo/${hash}`]: () =>
        new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
      [WRITE]: ({ body }) =>
        ++attempts === 1
          ? json(503, { error: 'temporarily_unavailable' })
          : json(200, { ...BRAND, brandLogo: hash, ...(body as object) }),
    })
    const form = await open()
    fireEvent.change(within(form).getByLabelText('Brand logo'), {
      target: { files: [new File(['{}'], 'logo.png', { type: 'image/png' })] },
    })
    fireEvent.change(within(form).getByLabelText('Primary colour'), {
      target: { value: '#123456' },
    })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    await within(form).findByRole('alert')
    expect(await within(form).findByAltText('Saved brand logo')).toBeDefined()
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    await within(form).findByText('Branding saved.')
    expect(api.to(UPLOAD)).toHaveLength(1)
    expect(api.to(WRITE).map((call) => call.body)).toEqual([
      { brandPrimaryColor: '#123456' },
      { brandPrimaryColor: '#123456' },
    ])
  })

  it.each(['owner', 'admin', 'member', 'unknown'])(
    'allows only verified administrative team roles: %s',
    async (role) => {
      const team = { ...ME, organization: { ...ME.organization, personal: false } }
      const api = fakeApi({
        ...signedInAs(team),
        ...emptyTeamLists,
        ...profile(),
        'GET /api/auth/organization/get-active-member': () =>
          role === 'unknown'
            ? json(503, {})
            : json(200, { organizationId: team.organization.id, userId: team.user.id, role }),
        [READ]: () => json(200, BRAND),
      })
      renderApp(PATHS.settings)
      const region = await screen.findByRole('region', { name: 'Booking page branding' })
      if (role === 'owner' || role === 'admin')
        await within(region).findByRole('button', { name: 'Manage branding' })
      else {
        await within(region).findByText(
          role === 'member'
            ? 'Only the personal owner or team owners and admins can manage branding.'
            : 'Branding access has not been confirmed.',
        )
        expect(within(region).queryByRole('button', { name: 'Manage branding' })).toBeNull()
      }
      expect(api.to(READ)).toHaveLength(0)
    },
  )

  it('keeps loading and failed reads neutral, without editable empty settings', async () => {
    const pending = later()
    fakeApi({ ...signedInAs(ME), ...profile(), [READ]: () => pending.response })
    renderApp(PATHS.settings)
    await userEvent.click(await screen.findByRole('button', { name: 'Manage branding' }))
    expect(await screen.findByText('Loading branding…')).toBeDefined()
    expect(screen.queryByLabelText('Primary colour')).toBeNull()
    await pending.answer(json(403, { error: 'insufficient_role' }))
    expect(await screen.findByText('Could not load branding.', { exact: false })).toBeDefined()
    expect(screen.queryByLabelText('Primary colour')).toBeNull()
  })

  it('locks a stale form after a space conflict and localizes errors and contrast guidance', async () => {
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [READ]: () => json(200, BRAND),
      [WRITE]: () => json(409, { error: 'organization_context_changed' }),
    })
    const form = await open()
    fireEvent.change(within(form).getByLabelText('Primary colour'), {
      target: { value: '#abcdef' },
    })
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    expect(await within(form).findByRole('alert')).toBeDefined()
    expect(
      (within(form).getByLabelText('Primary colour').closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(true)
    await userEvent.click(within(form).getByRole('button', { name: 'Save branding' }))
    expect(api.to(WRITE)).toHaveLength(1)
    await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(within(form).getByLabelText('主色')).toBeDefined()
    expect(within(form).getByRole('alert').textContent).not.toMatch(/[A-Za-z]{3}/)
    expect(within(form).getByText(/系统会自动选择黑色或白色按钮文字/)).toBeDefined()
  })
})
