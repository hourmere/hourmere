import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCatalogueLoader, INITIAL_LOCALE_WAIT_MS } from './catalogue-loader.ts'
import { type Catalog, knownMessage } from './catalogues.ts'
import {
  AccountLanguage,
  AdminCatalogueScope,
  CatalogueBoundary,
  InterfaceScope,
  LanguageSwitcher,
  useI18n,
} from './runtime.tsx'

const { loadChinese, loadGerman, loadFrench } = vi.hoisted(() => {
  vi.resetModules()
  return { loadChinese: vi.fn(), loadGerman: vi.fn(), loadFrench: vi.fn() }
})

vi.mock('./common.ts', async (importOriginal) => {
  await importOriginal()
  const { createCatalogueLoader: makeLoader } = await import('./catalogue-loader.ts')
  return {
    commonCatalogue: makeLoader(
      {
        './catalogues/zh-CN/common.ts': loadChinese,
        './catalogues/de/common.ts': loadGerman,
        './catalogues/fr/common.ts': loadFrench,
      },
      'common',
    ),
  }
})

function Content() {
  const { t, setLanguage } = useI18n()
  return (
    <>
      <h1>{t('Your details')}</h1>
      <button type="button" onClick={() => setLanguage('de')}>
        German
      </button>
      <button type="button" onClick={() => setLanguage('fr')}>
        French
      </button>
      <button type="button" onClick={() => setLanguage('en')}>
        English
      </button>
    </>
  )
}

function finish(load: typeof loadChinese) {
  const result = Promise.withResolvers<Catalog>()
  load.mockReturnValueOnce(result.promise)
  return result
}

function Profile({ loading }: { loading: boolean }) {
  return (
    <AccountLanguage locale={loading ? undefined : 'zh-CN'}>
      <CatalogueBoundary awaitingProfile={loading} fallback={<p role="status">Loading</p>}>
        <Content />
      </CatalogueBoundary>
    </AccountLanguage>
  )
}

describe('lazy interface catalogues', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for the profile and then its catalogue before showing the initial content', async () => {
    const chinese = finish(loadChinese)
    const { rerender } = render(<Profile loading />)
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(knownMessage('Your details')).toBe(true)
    expect(loadChinese).not.toHaveBeenCalled()
    rerender(<Profile loading={false} />)
    expect(screen.queryByRole('heading')).toBeNull()
    await act(() => chinese.resolve({ 'Your details': '中文详情' }))
    expect(screen.getByRole('heading').textContent).toBe('中文详情')
    expect(loadChinese).toHaveBeenCalledTimes(1)
  })

  it('shows English after the initial wait, then applies the catalogue without remounting', async () => {
    const german = finish(loadGerman)
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT'])
    render(
      <InterfaceScope surface="public" fallback={<p role="status">Loading</p>}>
        <Content />
      </InterfaceScope>,
    )
    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.queryByRole('heading')).toBeNull()
    act(() => vi.advanceTimersByTime(INITIAL_LOCALE_WAIT_MS))
    const heading = screen.getByRole('heading')
    expect(heading.textContent).toBe('Your details')
    await act(() => german.resolve({ 'Your details': 'Deutsche Angaben' }))
    expect(screen.getByRole('heading')).toBe(heading)
    expect(heading.textContent).toBe('Deutsche Angaben')
  })

  it('allows choosing English while the only other account language is downloading', async () => {
    const chinese = finish(loadChinese)
    const admin = createCatalogueLoader(
      { './catalogues/zh-CN/admin.ts': () => chinese.promise },
      'admin',
    )
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en'])
    render(
      <AdminCatalogueScope catalogue={admin}>
        <InterfaceScope surface="admin">
          <LanguageSwitcher />
        </InterfaceScope>
      </AdminCatalogueScope>,
    )
    const picker = screen.getByRole<HTMLSelectElement>('combobox')
    fireEvent.change(picker, { target: { value: 'zh-CN' } })
    expect(picker.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('en')
    fireEvent.change(picker, { target: { value: 'en' } })
    await act(() => chinese.resolve({}))
    expect(picker.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back on failure, retries, and ignores a slower earlier choice', async () => {
    const failure = finish(loadFrench)
    const retry = finish(loadFrench)
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en'])
    render(
      <InterfaceScope surface="public">
        <Content />
      </InterfaceScope>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'French' }))
    expect(screen.getByRole('heading').textContent).toBe('Your details')
    await act(() => failure.reject(new Error('network error')))
    expect(screen.getByRole('heading').textContent).toBe('Your details')
    fireEvent.click(screen.getByRole('button', { name: 'French' }))
    expect(loadFrench.mock.calls).toEqual([[0], [1]])
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('heading').textContent).toBe('Your details')
    await act(() => retry.resolve({ 'Your details': 'Détails en français' }))
    expect(screen.getByRole('heading').textContent).toBe('Your details')
    fireEvent.click(screen.getByRole('button', { name: 'French' }))
    expect(screen.getByRole('heading').textContent).toBe('Détails en français')
    expect(loadFrench).toHaveBeenCalledTimes(2)
  })
})
