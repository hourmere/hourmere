// Documentation tables are laid out by what each cell contains rather than by its column
// position (see styles/starlight.css). This Sätteri hast plugin classifies every body cell at
// build time, labels it with its column header for the stacked narrow layout, marks the
// separators inside code where a long value may wrap, and restores the table semantics that
// the block layout would otherwise drop.
import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri'

type HastPlugin = Exclude<
  NonNullable<SatteriProcessorOptions['hastPlugins']>[number],
  ((...args: never) => unknown) | readonly unknown[] | null | undefined | false
>
type Context = Parameters<NonNullable<HastPlugin['text']>>[1]
type HastNode = Parameters<Context['replaceNode']>[0]

// The structural subset of a hast node that the transform reads; the visited tree is frozen.
export interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: readonly Node[]
}

export type CellKind = 'short' | 'code' | 'prose'

// A cell holding only identifiers up to this length stays on one line.
export const SHORT_CODE_LENGTH = 32
// A cell holding only a plain label up to this length (Unset, Required, GET) stays on one line.
export const SHORT_TEXT_LENGTH = 20
// Code up to this length is never split, so it moves to the next line as a whole. Longer code,
// and any URL, gets a wrap opportunity after each run of these separator characters.
export const WHOLE_CODE_LENGTH = 24
export const CODE_SEPARATORS = /(?<=\S)[/_.?&=]+(?=\S)/g

const roles: Record<string, string> = {
  table: 'table',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tr: 'row',
  th: 'columnheader',
  td: 'cell',
}

function elements(node: Node, tagName: string, into: Node[] = []): Node[] {
  for (const child of node.children ?? []) {
    if (child.type !== 'element') continue
    if (child.tagName === tagName) into.push(child)
    elements(child, tagName, into)
  }
  return into
}

function text(node: Node, outsideCode = false): string {
  if (node.type === 'text') return node.value ?? ''
  if (outsideCode && node.tagName === 'code') return ''
  return (node.children ?? []).map((child) => text(child, outsideCode)).join('')
}

export function classifyCell(cell: Node): CellKind {
  const content = text(cell).trim()
  if (elements(cell, 'code').length > 0) {
    if (!/^[\s/,;|–-]*$/u.test(text(cell, true))) return 'prose'
    return content.length <= SHORT_CODE_LENGTH && !content.includes('://') ? 'short' : 'code'
  }
  if (elements(cell, 'a').length === 0 && content.length <= SHORT_TEXT_LENGTH) return 'short'
  return 'prose'
}

export function wrapsAtSeparators(code: string): boolean {
  return code.length > WHOLE_CODE_LENGTH || code.includes('://')
}

// Split code text at its separators into the text and <wbr> nodes that take its place.
export function splitAtSeparators(value: string): Node[] {
  const parts: Node[] = []
  let start = 0
  for (const match of value.matchAll(CODE_SEPARATORS)) {
    const end = match.index + match[0].length
    parts.push({ type: 'text', value: value.slice(start, end) })
    parts.push({ type: 'element', tagName: 'wbr', properties: {}, children: [] })
    start = end
  }
  parts.push({ type: 'text', value: value.slice(start) })
  return parts
}

export interface TableMutations {
  setProperty(node: Node, key: string, value: string): void
  replaceNode(node: Node, replacement: Node[]): void
}

// Queue the table mutations through the visitor context; the visited tree itself is frozen.
export function transformTable(table: Node, ctx: TableMutations) {
  for (const [tagName, role] of Object.entries(roles)) {
    for (const element of tagName === 'table' ? [table] : elements(table, tagName)) {
      if (!element.properties?.role) ctx.setProperty(element, 'role', role)
    }
  }
  const [head] = elements(table, 'thead')
  const headers = head ? elements(head, 'th').map((th) => text(th).trim()) : []
  for (const body of elements(table, 'tbody')) {
    for (const row of elements(body, 'tr')) {
      const cells = (row.children ?? []).filter((cell) => cell.tagName === 'td')
      cells.forEach((cell, index) => {
        const kind = classifyCell(cell)
        ctx.setProperty(cell, 'data-cell', kind)
        const label = headers[index]
        if (label) ctx.setProperty(cell, 'data-label', label)
        // A <wbr> breaks even unwrappable text, so short cells keep their code whole.
        if (kind === 'short') return
        for (const code of elements(cell, 'code')) {
          if (!wrapsAtSeparators(text(code))) continue
          for (const child of code.children ?? []) {
            if (child.type !== 'text' || !child.value) continue
            const parts = splitAtSeparators(child.value)
            if (parts.length > 1) ctx.replaceNode(child, parts)
          }
        }
      })
    }
  }
}

export default function docsTablesPlugin(): HastPlugin {
  return {
    name: 'hourmere-docs-tables',
    element: {
      filter: ['table'],
      visit(table, ctx) {
        transformTable(table, {
          setProperty: (node, key, value) => ctx.setProperty(node as HastNode, key, value),
          replaceNode: (node, parts) => ctx.replaceNode(node as HastNode, parts as HastNode[]),
        })
      },
    },
  }
}
