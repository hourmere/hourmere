import { act, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider, useRoutes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { UnsavedChangesProvider, useUnsavedChanges } from './unsaved-changes.tsx'

function Editor() {
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges(dirty)
  return (
    <button type="button" onClick={() => setDirty(!dirty)}>
      {dirty ? 'Revert' : 'Edit'}
    </button>
  )
}

function TestRoutes() {
  return useRoutes([
    { path: '/before', element: <p>Before editor</p> },
    {
      path: '/edit',
      element: (
        <UnsavedChangesProvider>
          <Editor />
        </UnsavedChangesProvider>
      ),
    },
  ])
}

function setup() {
  const router = createMemoryRouter([{ path: '*', element: <TestRoutes /> }], {
    initialEntries: ['/before', '/edit'],
    initialIndex: 1,
  })
  render(<RouterProvider router={router} />)
  return router
}

describe('unsaved browser history navigation', () => {
  it('keeps the dirty editor when dismissed, then allows a confirmed back navigation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = setup()
    await act(() => screen.getByRole('button', { name: 'Edit' }).click())
    await act(() => router.navigate(-1))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Revert' })).toBeDefined()
    expect(router.state.location.pathname).toBe('/edit')
    confirm.mockReturnValue(true)
    await act(() => router.navigate(-1))
    expect(await screen.findByText('Before editor')).toBeDefined()
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('does not warn for a clean or reverted draft (%s)', async (revert) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = setup()
    if (revert) {
      await act(() => screen.getByRole('button', { name: 'Edit' }).click())
      await act(() => screen.getByRole('button', { name: 'Revert' }).click())
    }
    await act(() => router.navigate(-1))
    expect(await screen.findByText('Before editor')).toBeDefined()
    expect(confirm).not.toHaveBeenCalled()
  })
})
