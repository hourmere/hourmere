import { render } from '@testing-library/react'
import { type RefObject, useLayoutEffect } from 'react'
import { expect, it } from 'vitest'
import { useMounted } from './hooks.ts'

let leftPage: RefObject<boolean> | null = null
const seenByNextPage: boolean[] = []

function LeftPage() {
  leftPage = useMounted()
  return <h1>Accept invitation</h1>
}

function NextPage() {
  // Runs in the commit that replaces LeftPage, before that commit's passive effects:
  // where a late answer to the left page's request can already arrive.
  useLayoutEffect(() => {
    if (leftPage) seenByNextPage.push(leftPage.current)
  }, [])
  return <h1>Connect an AI app</h1>
}

it('reports a page as left in the same commit that takes it off the screen', () => {
  const { rerender } = render(<LeftPage />)
  expect(leftPage?.current).toBe(true)
  rerender(<NextPage />)
  expect(seenByNextPage).toEqual([false])
})
