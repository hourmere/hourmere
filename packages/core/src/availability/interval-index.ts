export interface IndexedInterval {
  readonly start: bigint
  readonly end: bigint
}

/** Balanced interval tree: sort once, then prune whole subtrees outside each query. */
export function intervalIndex<T extends IndexedInterval>(intervals: readonly T[]) {
  const sorted = [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  interface Node {
    interval: T
    maximumEnd: bigint
    left?: Node
    right?: Node
  }
  function build(low: number, high: number): Node | undefined {
    if (low >= high) return undefined
    const middle = (low + high) >>> 1
    const interval = sorted[middle]
    if (!interval) return undefined
    const left = build(low, middle)
    const right = build(middle + 1, high)
    let maximumEnd = interval.end
    if (left && left.maximumEnd > maximumEnd) maximumEnd = left.maximumEnd
    if (right && right.maximumEnd > maximumEnd) maximumEnd = right.maximumEnd
    return { interval, maximumEnd, left, right }
  }
  const root = build(0, sorted.length)
  return (start: bigint, end: bigint): T[] => {
    const matches: T[] = []
    function visit(node: Node | undefined) {
      if (!node || node.maximumEnd <= start) return
      visit(node.left)
      if (node.interval.start >= end) return
      if (node.interval.end > start) matches.push(node.interval)
      visit(node.right)
    }
    visit(root)
    return matches
  }
}
