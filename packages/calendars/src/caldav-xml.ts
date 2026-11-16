import { SaxesParser } from 'saxes'
import { CALDAV_MAX_RESPONSE_BYTES, CalDavError } from './caldav-transport.ts'

const DAV = 'DAV:'
export interface Element {
  uri: string
  name: string
  text: string
  attributes: Record<string, string>
  children: Element[]
}
export function children(node: Element, uri: string, name: string) {
  return node.children.filter((n) => n.uri === uri && n.name === name)
}
export function first(node: Element, uri: string, name: string) {
  return children(node, uri, name)[0]
}
export function parse(body: string, rootName = 'multistatus'): Element {
  if (Buffer.byteLength(body) > CALDAV_MAX_RESPONSE_BYTES) throw new CalDavError('invalid_response')
  const stack: Element[] = []
  let root: Element | undefined
  let count = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => {
    throw new CalDavError('invalid_response')
  })
  parser.on('opentag', (tag) => {
    if (++count > 10_000 || stack.length >= 32) throw new CalDavError('invalid_response')
    const node = {
      uri: tag.uri,
      name: tag.local,
      text: '',
      attributes: Object.fromEntries(Object.values(tag.attributes).map((a) => [a.name, a.value])),
      children: [],
    }
    stack.at(-1)?.children.push(node)
    root ??= node
    stack.push(node)
  })
  parser.on('text', (text) => {
    const node = stack.at(-1)
    if (node) node.text += text
  })
  parser.on('cdata', (text) => {
    const node = stack.at(-1)
    if (node) node.text += text
  })
  parser.on('closetag', () => {
    stack.pop()
  })
  try {
    parser.write(body).close()
  } catch {
    throw new CalDavError('invalid_response')
  }
  if (!root || root.uri !== DAV || root.name !== rootName) throw new CalDavError('invalid_response')
  return root
}
export function properties(response: Element): Element[] {
  return children(response, DAV, 'propstat').flatMap((stat) =>
    /^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(first(stat, DAV, 'status')?.text.trim() ?? '')
      ? (first(stat, DAV, 'prop')?.children ?? [])
      : [],
  )
}
