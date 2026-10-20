import { expect, it, vi } from 'vitest'

const { install, createRoot, render } = vi.hoisted(() => {
  const render = vi.fn()
  return { install: vi.fn(), createRoot: vi.fn(() => ({ render })), render }
})
vi.mock('./preload-recovery.ts', () => ({ installPreloadRecovery: install }))
vi.mock('react-dom/client', () => ({ createRoot }))

it('registers chunk recovery before rendering the application', async () => {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  try {
    await import('./main.tsx')
    expect(install).toHaveBeenCalledOnce()
    expect(createRoot).toHaveBeenCalledWith(root)
    expect(render).toHaveBeenCalledOnce()
    expect(install.mock.invocationCallOrder[0]).toBeLessThan(
      createRoot.mock.invocationCallOrder[0] ?? 0,
    )
  } finally {
    root.remove()
  }
})
